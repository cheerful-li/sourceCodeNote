const queue = []
/**
  Variable to hold a counting semaphore
  - Incrementing adds a lock and puts the scheduler in a `suspended` state (if it's not
    already suspended)
  - Decrementing releases a lock. Zero locks puts the scheduler in a `released` state. This
    triggers flushing the queued tasks.
**/
// 信号量
// 主要是为了延时执行put, 避免一些操作的内部执行put，但是put的操作又未能被take捕获的问题
// 相比 setTimeout(fn, 0)和Promise.resolve()等方式更加高效
let semaphore = 0

/**
  Executes a task 'atomically'. Tasks scheduled during this execution will be queued
  and flushed after this task has finished (assuming the scheduler endup in a released
  state).
**/
function exec(task) {
  try {
    suspend()
    // task执行过程中，可能会插入其它task
    // 确保插入的task不会中途执行，必须在当前task执行完毕后，依次执行
    task()
  } finally {
    release()
  }
}

/**
  Executes or queues a task depending on the state of the scheduler (`suspended` or `released`)
**/
// asap 尽快， as soon as possible
export function asap(task) {
  // 放入队列
  queue.push(task)

  // 当前队列无其它任务，直接开始执行
  if (!semaphore) {
    suspend()
    flush()
  }
}

/**
  Puts the scheduler in a `suspended` state. Scheduled tasks will be queued until the
  scheduler is released.
**/
export function suspend() {
  semaphore++
}

/**
  Puts the scheduler in a `released` state.
**/
function release() {
  semaphore--
}

/**
  Releases the current lock. Executes all queued tasks if the scheduler is in the released state.
**/
export function flush() {
  release()

  let task
  // 信号量为0时， 执行队列里面全部任务
  while (!semaphore && (task = queue.shift()) !== undefined) {
    exec(task)
  }
}
