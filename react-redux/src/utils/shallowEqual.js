const hasOwn = Object.prototype.hasOwnProperty

// 完全相等
function is(x, y) {
  if (x === y) {
    // 区分 +0 和 -0
    return x !== 0 || y !== 0 || 1 / x === 1 / y
  } else {
    return x !== x && y !== y
  }
}

export default function shallowEqual(objA, objB) {
  if (is(objA, objB)) return true

  // 不是对象或者数组，也不完全相等，结果就是不等
  if (typeof objA !== 'object' || objA === null ||
      typeof objB !== 'object' || objB === null) {
    return false
  }
  // 对象或数组
  const keysA = Object.keys(objA)
  const keysB = Object.keys(objB)
  // 快速判断
  if (keysA.length !== keysB.length) return false
  // 比较对象或者数组的每一项，每一对应项必须绝对相等，不会进一步的比较深层次的对象或数组
  for (let i = 0; i < keysA.length; i++) {
    if (!hasOwn.call(objB, keysA[i]) ||
        !is(objA[keysA[i]], objB[keysA[i]])) {
      return false
    }
  }

  return true
}
