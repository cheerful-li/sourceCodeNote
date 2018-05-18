import { is, check, object, createSetContextWarning } from './utils'
import { stdChannel } from './channel'
import { identity } from './utils'
import { runSaga } from './runSaga'

export default function sagaMiddlewareFactory({ context = {}, ...options } = {}) {
  // sagaMonitor参数是一个对象， 包含 effectTriggered effectResolved effectRejected effectCancelled actionDispatched 五个事件函数
  // redux-sage在对应的时机会触发对应的事件函数
  const { sagaMonitor, logger, onError, effectMiddlewares } = options

  // 检查选项是否合法
  if (process.env.NODE_ENV === 'development') {
    if (is.notUndef(logger)) {
      check(logger, is.func, 'options.logger passed to the Saga middleware is not a function!')
    }

    if (is.notUndef(onError)) {
      check(onError, is.func, 'options.onError passed to the Saga middleware is not a function!')
    }

    if (is.notUndef(options.emitter)) {
      check(options.emitter, is.func, 'options.emitter passed to the Saga middleware is not a function!')
    }
  }

  function sagaMiddleware({ getState, dispatch }) {
    const channel = stdChannel()
    // emitter参数可以用来对channel.put做包装
    channel.put = (options.emitter || identity)(channel.put)

    sagaMiddleware.run = runSaga.bind(null, {
      context,
      channel,
      dispatch,
      getState,
      sagaMonitor,
      logger,
      onError,
      effectMiddlewares,
    })

    // 包装store的dispatch
    return next => action => {
      // 触发actionDispatched事件回调
      if (sagaMonitor && sagaMonitor.actionDispatched) {
        sagaMonitor.actionDispatched(action)
      }
      // 先触发store的dispatch
      const result = next(action) // hit reducers
      // 再触发redux-saga的saga
      channel.put(action)
      return result
    }
  }

  sagaMiddleware.run = () => {
    throw new Error('Before running a Saga, you must mount the Saga middleware on the Store using applyMiddleware')
  }

  sagaMiddleware.setContext = props => {
    if (process.env.NODE_ENV === 'development') {
      check(props, is.object, createSetContextWarning('sagaMiddleware', props))
    }

    object.assign(context, props)
  }

  return sagaMiddleware
}
