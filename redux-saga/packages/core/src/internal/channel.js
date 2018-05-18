import { CHANNEL_END_TYPE, MATCH, MULTICAST, SAGA_ACTION } from './symbols'
import { is, check, remove, once, internalErr } from './utils'
import * as buffers from './buffers'
import { asap } from './scheduler'
import * as matchers from './matcher'

export const END = { type: CHANNEL_END_TYPE }
export const isEnd = a => a && a.type === CHANNEL_END_TYPE

const INVALID_BUFFER = 'invalid buffer passed to channel factory function'
const UNDEFINED_INPUT_ERROR = `Saga or channel was provided with an undefined action
Hints:
  - check that your Action Creator returns a non-undefined value
  - if the Saga was started using runSaga, check that your subscribe source provides the action to its listeners`

export function channel(buffer = buffers.expanding()) {
  let closed = false
  let takers = []

  if (process.env.NODE_ENV === 'development') {
    check(buffer, is.buffer, INVALID_BUFFER)
  }

  function checkForbiddenStates() {
    if (closed && takers.length) {
      throw internalErr('Cannot have a closed channel with pending takers')
    }
    if (takers.length && !buffer.isEmpty()) {
      throw internalErr('Cannot have pending takers with non empty buffer')
    }
  }

  function put(input) {
    checkForbiddenStates()

    if (process.env.NODE_ENV === 'development') {
      check(input, is.notUndef, UNDEFINED_INPUT_ERROR)
    }

    if (closed) {
      return
    }
    if (!takers.length) {
      return buffer.put(input)
    }
    const cb = takers[0]
    takers.splice(0, 1)
    cb(input)
  }

  function take(cb) {
    checkForbiddenStates()

    if (process.env.NODE_ENV === 'development') {
      check(cb, is.func, "channel.take's callback must be a function")
    }

    if (closed && buffer.isEmpty()) {
      cb(END)
    } else if (!buffer.isEmpty()) {
      cb(buffer.take())
    } else {
      takers.push(cb)
      cb.cancel = () => remove(takers, cb)
    }
  }

  function flush(cb) {
    checkForbiddenStates() // TODO: check if some new state should be forbidden now

    if (process.env.NODE_ENV === 'development') {
      check(cb, is.func, "channel.flush' callback must be a function")
    }

    if (closed && buffer.isEmpty()) {
      cb(END)
      return
    }
    cb(buffer.flush())
  }

  function close() {
    checkForbiddenStates()
    if (!closed) {
      closed = true
      if (takers.length) {
        const arr = takers
        takers = []
        for (let i = 0, len = arr.length; i < len; i++) {
          const taker = arr[i]
          taker(END)
        }
      }
    }
  }

  return {
    take,
    put,
    flush,
    close,
  }
}

export function eventChannel(subscribe, buffer = buffers.none()) {
  let closed = false
  let unsubscribe

  const chan = channel(buffer)
  const close = () => {
    if (is.func(unsubscribe)) {
      unsubscribe()
    }
    chan.close()
  }

  unsubscribe = subscribe(input => {
    if (isEnd(input)) {
      close()
      closed = true
      return
    }
    chan.put(input)
  })

  if (!is.func(unsubscribe)) {
    throw new Error('in eventChannel: subscribe should return a function to unsubscribe')
  }

  unsubscribe = once(unsubscribe)

  if (closed) {
    unsubscribe()
  }

  return {
    take: chan.take,
    flush: chan.flush,
    close,
  }
}

export function multicastChannel() {
  let closed = false
  let currentTakers = []
  let nextTakers = currentTakers

  // 确保在遍历执行currentTakers过程中，不会修改到currentTakers(添加taker，删除taker等操作)
  // 意思就是在每次遍历中，新的taker总是应该在下一次遍历才会被执行
  const ensureCanMutateNextTakers = () => {
    if (nextTakers !== currentTakers) {
      return
    }
    nextTakers = currentTakers.slice()
  }

  // TODO: check if its possible to extract closing function and reuse it in both unicasts and multicasts
  const close = () => {
    closed = true
    const takers = (currentTakers = nextTakers)
    // 关闭的时候，所有taker执行，传入END action
    for (let i = 0; i < takers.length; i++) {
      const taker = takers[i]
      taker(END)
    }

    nextTakers = []
  }

  return {
    [MULTICAST]: true,
    put(input) { // input 参数比较通用， 但是结合redux来用的话，就是指action
      // TODO: should I check forbidden state here? 1 of them is even impossible
      // as we do not possibility of buffer here
      if (process.env.NODE_ENV === 'development') {
        check(input, is.notUndef, UNDEFINED_INPUT_ERROR)
      }

      if (closed) {
        return
      }
      // 可以触发redux-saga暴露的END action, 来关闭通道
      if (isEnd(input)) {
        close()
        return
      }

      const takers = (currentTakers = nextTakers)
      // 遍历takers, 执行匹配规则
      for (let i = 0; i < takers.length; i++) {
        const taker = takers[i]
        if (taker[MATCH](input)) { // 匹配时， 执行taker, 删除taker
          taker.cancel()
          taker(input)
        }
      }
    },
    /*
    * matcher 可以有几种取值
    * 不传 或者 * 全部匹配
    * 字符串或者symbol, ===匹配
    * 有toString的函数， 函数toString后===匹配
    * 函数， 执行函数，返回true时匹配
    * */
    take(cb, matcher = matchers.wildcard) {
      if (closed) {
        cb(END)
        return
      }
      cb[MATCH] = matcher
      ensureCanMutateNextTakers()
      nextTakers.push(cb)

      cb.cancel = once(() => {
        ensureCanMutateNextTakers()
        remove(nextTakers, cb)
      })
    },
    close,
  }
}

export function stdChannel() {
  const chan = multicastChannel()
  const { put } = chan
  chan.put = input => {
    // saga中put的action不受下面规则约束，总是最快执行
    if (input[SAGA_ACTION]) {
      put(input)
      return
    }
    // action执行过程中，可能会dispatch其它action
    // 确保新加入的action，必须在当前action执行完毕后，才被dispatch执行
    asap(() => put(input))
  }
  return chan
}
