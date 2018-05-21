import {
  CANCEL,
  CHANNEL_END as CHANNEL_END_SYMBOL,
  TASK,
  TASK_CANCEL as TASK_CANCEL_SYMBOL,
  SELF_CANCELLATION,
} from './symbols'
import {
  noop,
  is,
  log as _log,
  check,
  deferred,
  uid as nextEffectId,
  array,
  remove,
  object,
  makeIterator,
  createSetContextWarning,
} from './utils'

import { getLocation, addSagaStack, sagaStackToString } from './error-utils'

import { asap, suspend, flush } from './scheduler'
import { asEffect } from './io'
import { channel, isEnd } from './channel'
import matcher from './matcher'

export function getMetaInfo(fn) {
  return {
    name: fn.name || 'anonymous',
    location: getLocation(fn),
  }
}

function getIteratorMetaInfo(iterator, fn) {
  if (iterator.isSagaIterator) {
    return { name: iterator.meta.name }
  }
  return getMetaInfo(fn)
}

// TODO: check if this hacky toString stuff is needed
// also check again whats the difference between CHANNEL_END and CHANNEL_END_TYPE
// maybe this could become MAYBE_END
// I guess this gets exported so takeMaybe result can be checked
export const CHANNEL_END = {
  toString() {
    return CHANNEL_END_SYMBOL
  },
}
export const TASK_CANCEL = {
  toString() {
    return TASK_CANCEL_SYMBOL
  },
}

/**
  Used to track a parent task and its forks
  In the new fork model, forked tasks are attached by default to their parent
  We model this using the concept of Parent task && main Task
  main task is the main flow of the current Generator, the parent tasks is the
  aggregation of the main tasks + all its forked tasks.
  Thus the whole model represents an execution tree with multiple branches (vs the
  linear execution tree in sequential (non parallel) programming)

  A parent tasks has the following semantics
  - It completes if all its forks either complete or all cancelled
  - If it's cancelled, all forks are cancelled as well
  - It aborts if any uncaught error bubbles up from forks
  - If it completes, the return value is the one returned by the main task
**/
// 每个generator函数在执行的时候， 跟踪主流程mainTask和fork的task
// 一个generator函数的执行过程是一个parent task
// parent task的完成需要mainTask和所有的fork完成或者被取消
// 如果parent task被取消，那么mainTask和所有的fork都会被取消
// 如果forks或者mainTask有错误发生， parent task将会被abort
// parent task完成时的返回值就是main task的返回值
function forkQueue(mainTask, onAbort, cb) {
  let tasks = [],
    result,
    completed = false
  addTask(mainTask)
  const getTasks = () => tasks
  const getTaskNames = () => tasks.map(t => t.meta.name)

  function abort(err) {
    onAbort()
    cancelAll()
    cb(err, true)
  }

  function addTask(task) {
    tasks.push(task)
    // continuation
    task.cont = (res, isErr) => {
      if (completed) {
        return
      }

      remove(tasks, task)
      task.cont = noop
      // 但凡是有一个task抛错， 取消掉所有task, generator function 执行结束
      if (isErr) {
        abort(res)
      } else {
        if (task === mainTask) {
          // mainTask的返回结果是整个generator function的返回结果
          result = res
        }
        // 所有task完成
        if (!tasks.length) {
          completed = true
          cb(result)
        }
      }
    }
    // task.cont.cancel = task.cancel
  }

  function cancelAll() {
    if (completed) {
      return
    }
    completed = true
    tasks.forEach(t => {
      t.cont = noop
      t.cancel()
    })
    tasks = []
  }

  return {
    addTask,
    cancelAll,
    abort,
    getTasks,
    getTaskNames,
  }
}

function createTaskIterator({ context, fn, args }) {
  if (is.iterator(fn)) {
    return fn
  }

  // catch synchronous failures; see #152 and #441
  let result, error
  try {
    result = fn.apply(context, args)
  } catch (err) {
    error = err
  }

  // i.e. a generator function returns an iterator
  if (is.iterator(result)) {
    return result
  }

  // do not bubble up synchronous failures for detached forks
  // instead create a failed task. See #152 and #441
  return error
    ? makeIterator(() => {
        throw error
      })
    : makeIterator(
        (function() {
          let pc
          const eff = { done: false, value: result }
          const ret = value => ({ done: true, value })
          return arg => {
            if (!pc) {
              pc = true
              return eff
            } else {
              return ret(arg)
            }
          }
        })(),
      )
}

// 处理 generator function 生成的 iterator的执行
export default function proc(
  iterator,
  stdChannel,
  dispatch = noop,
  getState = noop,
  parentContext = {},
  options = {},
  parentEffectId = 0,
  meta,
  cont,
) {
  const { sagaMonitor, logger, onError, middleware } = options
  const log = logger || _log

  const logError = err => {
    log('error', err)
    if (err && err.sagaStack) {
      log('error', err.sagaStack)
    }
  }
  // 创建一个新context, 继承自parentContext
  const taskContext = Object.create(parentContext)
  // 报错的effect
  let crashedEffect = null
  const cancelledDueToErrorTasks = []
  /**
    Tracks the current effect cancellation
    Each time the generator progresses. calling runEffect will set a new value
    on it. It allows propagating cancellation to child effects
  **/
  next.cancel = noop

  /**
    Creates a new task descriptor for this generator, We'll also create a main task
    to track the main flow (besides other forked tasks)
  **/
  const task = newTask(parentEffectId, meta, iterator, cont)
  const mainTask = { meta, cancel: cancelMain, isRunning: true }

  const taskQueue = forkQueue(
    mainTask,
    function onAbort() {
      cancelledDueToErrorTasks.push(...taskQueue.getTaskNames())
    },
    end,
  )

  /**
    cancellation of the main task. We'll simply resume the Generator with a Cancel
  **/
  function cancelMain() {
    if (mainTask.isRunning && !mainTask.isCancelled) {
      mainTask.isCancelled = true
      next(TASK_CANCEL)
    }
  }

  /**
    This may be called by a parent generator to trigger/propagate cancellation
    cancel all pending tasks (including the main task), then end the current task.

    Cancellation propagates down to the whole execution tree holded by this Parent task
    It's also propagated to all joiners of this task and their execution tree/joiners

    Cancellation is noop for terminated/Cancelled tasks tasks
  **/
  function cancel() {
    /**
      We need to check both Running and Cancelled status
      Tasks can be Cancelled but still Running
    **/
    if (iterator._isRunning && !iterator._isCancelled) {
      iterator._isCancelled = true
      taskQueue.cancelAll()
      /**
        Ending with a Never result will propagate the Cancellation to all joiners
      **/
      end(TASK_CANCEL)
    }
  }
  /**
    attaches cancellation logic to this task's continuation
    this will permit cancellation to propagate down the call chain
  **/
  cont && (cont.cancel = cancel)

  // tracks the running status
  iterator._isRunning = true

  // kicks up the generator
  next()

  // then return the task descriptor to the caller
  return task

  /**
    This is the generator driver
    It's a recursive async/continuation function which calls itself
    until the generator terminates or throws
  **/
  function next(arg, isErr) {
    // Preventive measure. If we end up here, then there is really something wrong
    if (!mainTask.isRunning) {
      throw new Error('Trying to resume an already finished generator')
    }

    try {
      let result
      if (isErr) {
        result = iterator.throw(arg)
      } else if (arg === TASK_CANCEL) {
        /**
          getting TASK_CANCEL automatically cancels the main task
          We can get this value here

          - By cancelling the parent task manually
          - By joining a Cancelled task
        **/
        mainTask.isCancelled = true
        /**
          Cancels the current effect; this will propagate the cancellation down to any called tasks
        **/
        // next.cancel 由当前正在被block的effect注册
        next.cancel()
        /**
          If this Generator has a `return` method then invokes it
          This will jump to the finally block
        **/
        // generator function 被cancel后， 执行iterator.return, 可以进入finally代码块，
        // finally代码块里面可以通过 yield cancelled()判断当前generator function是否是被cancel, 其本质其实也是判断mainTask.isCancelled = true
        // finally代码块可以包含yield代码，可以继续next, iterator.return的结果会在最终的执行完后返回
        result = is.func(iterator.return) ? iterator.return(TASK_CANCEL) : { done: true, value: TASK_CANCEL }
      } else if (arg === CHANNEL_END) {
        // We get CHANNEL_END by taking from a channel that ended using `take` (and not `takem` used to trap End of channels)
        result = is.func(iterator.return) ? iterator.return() : { done: true }
      } else {
        result = iterator.next(arg)
      }
      // generator function还没执行完
      if (!result.done) {
        // 下一步
        digestEffect(result.value, parentEffectId, '', next)
      } else {
        /**
          This Generator has ended, terminate the main task and notify the fork queue
        **/
        // 主流程执行完毕， 处理结果
        mainTask.isMainRunning = false
        mainTask.cont && mainTask.cont(result.value)
      }
    } catch (error) {
      // 抛错
      if (mainTask.isCancelled) {
        logError(error)
      }
      mainTask.isMainRunning = false
      mainTask.cont(error, true)
    }
  }

  // iterator执行完毕
  // 有返回值或者有错误
  function end(result, isErr) {
    iterator._isRunning = false
    // stdChannel.close()

    if (!isErr) {
      iterator._result = result
      iterator._deferredEnd && iterator._deferredEnd.resolve(result)
    } else {
      // 有错误时，记录调用栈
      addSagaStack(result, {
        meta,
        effect: crashedEffect,
        cancelledTasks: cancelledDueToErrorTasks,
      })

      if (!task.cont) {
        if (result && result.sagaStack) {
          result.sagaStack = sagaStackToString(result.sagaStack)
        }

        if (onError) {
          onError(result)
        } else {
          // TODO: could we skip this when _deferredEnd is attached?
          logError(result)
        }
      }
      iterator._error = result
      iterator._isAborted = true
      iterator._deferredEnd && iterator._deferredEnd.reject(result)
    }
    task.cont && task.cont(result, isErr)
    task.joiners.forEach(j => j.cb(result, isErr))
    task.joiners = null
  }

  function runEffect(effect, effectId, currCb) {
    /**
      each effect runner must attach its own logic of cancellation to the provided callback
      it allows this generator to propagate cancellation downward.

      ATTENTION! effect runners must setup the cancel logic by setting cb.cancel = [cancelMethod]
      And the setup must occur before calling the callback

      This is a sort of inversion of control: called async functions are responsible
      of completing the flow by calling the provided continuation; while caller functions
      are responsible for aborting the current flow by calling the attached cancel function

      Library users can attach their own cancellation logic to promises by defining a
      promise[CANCEL] method in their returned promises
      ATTENTION! calling cancel must have no effect on an already completed or cancelled effect
    **/
    let data
    // prettier-ignore
    return (
      // Non declarative effect
      // 处理Promise
        is.promise(effect)                      ? resolvePromise(effect, currCb)
      // 处理iterator
      : is.iterator(effect)                     ? resolveIterator(effect, effectId, meta, currCb)

      // declarative effects
      // 处理声明式effects, 检查标记
      : (data = asEffect.take(effect))          ? runTakeEffect(data, currCb)
      : (data = asEffect.put(effect))           ? runPutEffect(data, currCb)
      : (data = asEffect.all(effect))           ? runAllEffect(data, effectId, currCb)
      : (data = asEffect.race(effect))          ? runRaceEffect(data, effectId, currCb)
      : (data = asEffect.call(effect))          ? runCallEffect(data, effectId, currCb)
      : (data = asEffect.cps(effect))           ? runCPSEffect(data, currCb)
      : (data = asEffect.fork(effect))          ? runForkEffect(data, effectId, currCb)
      : (data = asEffect.join(effect))          ? runJoinEffect(data, currCb)
      : (data = asEffect.cancel(effect))        ? runCancelEffect(data, currCb)
      : (data = asEffect.select(effect))        ? runSelectEffect(data, currCb)
      : (data = asEffect.actionChannel(effect)) ? runChannelEffect(data, currCb)
      : (data = asEffect.flush(effect))         ? runFlushEffect(data, currCb)
      : (data = asEffect.cancelled(effect))     ? runCancelledEffect(data, currCb)
      : (data = asEffect.getContext(effect))    ? runGetContextEffect(data, currCb)
      : (data = asEffect.setContext(effect))    ? runSetContextEffect(data, currCb)
      // 处理其他值， 直接作为返回值
      : /* anything else returned as is */        currCb(effect)
    )
  }

  function digestEffect(effect, parentEffectId, label = '', cb) {
    const effectId = nextEffectId()
    sagaMonitor && sagaMonitor.effectTriggered({ effectId, parentEffectId, label, effect })

    /**
      completion callback and cancel callback are mutually exclusive
      We can't cancel an already completed effect
      And We can't complete an already cancelled effectId
    **/
    // 当前effect是否已执行完成或者已cancel
    // 通过这个标识，来避免多次调用
    let effectSettled

    // Completion callback passed to the appropriate effect runner
    // effect执行完成时调用
    // 第二个参数若为true,标识有错误发生，第一个参数就是错误信息
    function currCb(res, isErr) {
      if (effectSettled) {
        return
      }

      effectSettled = true
      // 取消上层回调的cancel注册
      cb.cancel = noop // defensive measure
      if (sagaMonitor) {
        isErr ? sagaMonitor.effectRejected(effectId, res) : sagaMonitor.effectResolved(effectId, res)
      }
      if (isErr) {
        crashedEffect = effect
      }
      // 执行上层回调
      cb(res, isErr)
    }
    // tracks down the current cancel
    currCb.cancel = noop

    // setup cancellation logic on the parent cb
    // 给上层回调注册cancel回调
    cb.cancel = () => {
      // prevents cancelling an already completed effect
      // 避免多次调用
      if (effectSettled) {
        return
      }

      effectSettled = true
      /**
        propagates cancel downward
        catch uncaught cancellations errors; since we can no longer call the completion
        callback, log errors raised during cancellations into the console
      **/
      try {
        // 下层处理时，给回调函数currCb注册的cancel方法
        // 这样上层在调用cb.cancel时会向下传播,然后调用currCb.cancel
        currCb.cancel()
      } catch (err) {
        logError(err)
      }
      currCb.cancel = noop // defensive measure

      sagaMonitor && sagaMonitor.effectCancelled(effectId)
    }

    // if one can find a way to decouple runEffect from closure variables
    // so it could be the call to it could be referentially transparent
    // this potentially could be simplified, finalRunEffect created beforehand
    // and this part of the code wouldnt have to know about middleware stuff
    if (is.func(middleware)) {
      middleware(eff => runEffect(eff, effectId, currCb))(effect)
      return
    }
    // 执行effect的逻辑在这里面
    runEffect(effect, effectId, currCb)
  }
  // yield promise 的执行逻辑
  function resolvePromise(promise, cb) {
    // promise 有两种方式注册cancel时的动作
    // 添加[CANCEL]方法， 或者添加abort方法
    const cancelPromise = promise[CANCEL]
    // cancel方法放到cb上f
    if (is.func(cancelPromise)) {
      cb.cancel = cancelPromise
    } else if (is.func(promise.abort)) {
      cb.cancel = () => promise.abort()
    }

    promise.then(cb, error => cb(error, true))
  }

  // yield generatorFunc() 的执行逻辑
  function resolveIterator(iterator, effectId, meta, cb) {
    // iterator 由 proc处理
    proc(iterator, stdChannel, dispatch, getState, taskContext, options, effectId, meta, cb)
  }

  function runTakeEffect({ channel = stdChannel, pattern, maybe }, cb) {
    const takeCb = input => {
      // 错误处理
      if (input instanceof Error) {
        cb(input, true)
        return
      }
      // action是一个CHANNEL_END的action，所有take都会被触发
      // taker.maybe例外
      if (isEnd(input) && !maybe) {
        cb(CHANNEL_END)
        return
      }
      // 匹配的action
      cb(input)
    }
    try {
      // 给channel注册take, 当匹配到pattern的action时， 执行回调
      channel.take(takeCb, is.notUndef(pattern) ? matcher(pattern) : null)
    } catch (err) {
      cb(err, true)
      return
    }
    cb.cancel = takeCb.cancel
  }

  function runPutEffect({ channel, action, resolve }, cb) {
    /**
      Schedule the put in case another saga is holding a lock.
      The put will be executed atomically. ie nested puts will execute after
      this put has terminated.
    **/
    // 考虑一个put的执行过程中发起另一个put, 那么另外一个put需要在当前put的同步代码执行完毕后再执行
    // 例如： put1 的 generator函数中put2 正确的逻辑是 put1 -> put1 end -> put2 -> put2 end 而不是 put1 -> put2 -> put2 end -> put1 end
    asap(() => {
      let result
      try {
        // channel.put 最终也会dispatch到store
        result = (channel ? channel.put : dispatch)(action)
      } catch (error) {
        cb(error, true)
        return
      }
      // put.resolve
      if (resolve && is.promise(result)) {
        resolvePromise(result, cb)
      } else {
        cb(result)
        return
      }
    })
    // Put effects are non cancellables
  }
  // yiled call(api, args)
  // api的返回值可以是promise或者iterator或者其它值
  function runCallEffect({ context, fn, args }, effectId, cb) {
    let result
    // catch synchronous failures; see #152
    try {
      result = fn.apply(context, args)
    } catch (error) {
      cb(error, true)
      return
    }
    return is.promise(result)
      ? resolvePromise(result, cb)
      : is.iterator(result) ? resolveIterator(result, effectId, getMetaInfo(fn), cb) : cb(result)
  }
  // nodejs 风格的回调
  // yield cps(fn, args)
  // fn的最后一个参数是结果回调函数 function (error, res) {}
  function runCPSEffect({ context, fn, args }, cb) {
    // CPS (ie node style functions) can define their own cancellation logic
    // by setting cancel field on the cb

    // catch synchronous failures; see #152
    try {
      const cpsCb = (err, res) => (is.undef(err) ? cb(res) : cb(err, true))
      fn.apply(context, args.concat(cpsCb))
      // cpsCb函数上可以注册cancel方法
      if (cpsCb.cancel) {
        cb.cancel = () => cpsCb.cancel()
      }
    } catch (error) {
      cb(error, true)
      return
    }
  }

  function runForkEffect({ context, fn, args, detached }, effectId, cb) {
    // 处理成iterator
    const taskIterator = createTaskIterator({ context, fn, args })
    const meta = getIteratorMetaInfo(taskIterator, fn)
    try {

      // see https://github.com/redux-saga/redux-saga/issues/277
      // yield takeEvery('USER_REQUESTED', fetchUser)  (takerEvery 内部是一个while循环， take and fork)
      // fetchUser里面put({ type: 'USER_REQUESTED'})
      // 如果不加suspend和flush, 那么put的操作可能在fork完成cb回调之前就执行了，此时take还未执行完成,因此会丢失下一次take

      suspend()
      const task = proc(
        taskIterator,
        stdChannel,
        dispatch,
        getState,
        taskContext,
        options,
        effectId,
        meta,
        detached ? null : noop,
      )
      // spawn
      if (detached) {
        cb(task)
      } else {
        // 添加task到taskQueue
        if (taskIterator._isRunning) {
          taskQueue.addTask(task)
          cb(task)
        } else if (taskIterator._error) {
          // 同步执行报错
          taskQueue.abort(taskIterator._error)
        } else {
          // 同步执行完成
          cb(task)
        }
      }
    } finally {
      flush()
    }
    // Fork effects are non cancellables
  }

  function runJoinEffect(t, cb) {
    if (t.isRunning()) {
      const joiner = { task, cb }
      cb.cancel = () => remove(t.joiners, joiner)
      t.joiners.push(joiner)
    } else {
      t.isAborted() ? cb(t.error(), true) : cb(t.result())
    }
  }

  function runCancelEffect(taskToCancel, cb) {
    if (taskToCancel === SELF_CANCELLATION) {
      taskToCancel = task
    }
    if (taskToCancel.isRunning()) {
      // 最终会执行taskToCancel.cont
      // 等同于taskToCancel执行完毕，会从taskQueue中删除
      taskToCancel.cancel()
    }
    cb()
    // cancel effects are non cancellables
  }

  function runAllEffect(effects, effectId, cb) {
    const keys = Object.keys(effects)

    if (!keys.length) {
      cb(is.array(effects) ? [] : {})
      return
    }

    let completedCount = 0
    let completed
    const results = {}
    const childCbs = {}

    function checkEffectEnd() {
      if (completedCount === keys.length) {
        completed = true
        cb(is.array(effects) ? array.from({ ...results, length: keys.length }) : results)
      }
    }

    keys.forEach(key => {
      const chCbAtKey = (res, isErr) => {
        if (completed) {
          return
        }
        if (isErr || isEnd(res) || res === CHANNEL_END || res === TASK_CANCEL) {
          cb.cancel()
          cb(res, isErr)
        } else {
          results[key] = res
          completedCount++
          checkEffectEnd()
        }
      }
      chCbAtKey.cancel = noop
      childCbs[key] = chCbAtKey
    })

    cb.cancel = () => {
      if (!completed) {
        completed = true
        keys.forEach(key => childCbs[key].cancel())
      }
    }

    keys.forEach(key => digestEffect(effects[key], effectId, key, childCbs[key]))
  }

  function runRaceEffect(effects, effectId, cb) {
    let completed
    const keys = Object.keys(effects)
    const childCbs = {}

    keys.forEach(key => {
      const chCbAtKey = (res, isErr) => {
        if (completed) {
          return
        }

        if (isErr) {
          // Race Auto cancellation
          cb.cancel()
          cb(res, true)
        } else if (!isEnd(res) && res !== CHANNEL_END && res !== TASK_CANCEL) {
          cb.cancel()
          completed = true
          const response = { [key]: res }
          cb(is.array(effects) ? [].slice.call({ ...response, length: keys.length }) : response)
        }
      }
      chCbAtKey.cancel = noop
      childCbs[key] = chCbAtKey
    })

    cb.cancel = () => {
      // prevents unnecessary cancellation
      if (!completed) {
        completed = true
        keys.forEach(key => childCbs[key].cancel())
      }
    }
    keys.forEach(key => {
      if (completed) {
        return
      }
      digestEffect(effects[key], effectId, key, childCbs[key])
    })
  }

  function runSelectEffect({ selector, args }, cb) {
    try {
      const state = selector(getState(), ...args)
      cb(state)
    } catch (error) {
      cb(error, true)
    }
  }

  // actionChannel处理
  function runChannelEffect({ pattern, buffer }, cb) {
    // TODO: rethink how END is handled
    const chan = channel(buffer)
    const match = matcher(pattern)

    const taker = action => {
      // 不是channel end的话，继续take
      if (!isEnd(action)) {
        stdChannel.take(taker, match)
      }
      chan.put(action)
    }
    // taker只会调用一次，在taker回调里面判断是否需要继续take
    stdChannel.take(taker, match)
    cb(chan)
  }

  // yield cancelled()
  function runCancelledEffect(data, cb) {
    cb(!!mainTask.isCancelled)
  }

  function runFlushEffect(channel, cb) {
    channel.flush(cb)
  }

  function runGetContextEffect(prop, cb) {
    cb(taskContext[prop])
  }

  function runSetContextEffect(props, cb) {
    object.assign(taskContext, props)
    cb()
  }

  function newTask(id, meta, iterator, cont) {
    iterator._deferredEnd = null
    return {
      [TASK]: true,
      id,
      meta,
      toPromise() {
        if (iterator._deferredEnd) {
          return iterator._deferredEnd.promise
        }

        const def = deferred()
        iterator._deferredEnd = def

        if (!iterator._isRunning) {
          if (iterator._isAborted) {
            def.reject(iterator._error)
          } else {
            def.resolve(iterator._result)
          }
        }

        return def.promise
      },
      cont,
      joiners: [],
      cancel,
      isRunning: () => iterator._isRunning,
      isCancelled: () => iterator._isCancelled,
      isAborted: () => iterator._isAborted,
      result: () => iterator._result,
      error: () => iterator._error,
      setContext(props) {
        if (process.env.NODE_ENV === 'development') {
          check(props, is.object, createSetContextWarning('task', props))
        }

        object.assign(taskContext, props)
      },
    }
  }
}
