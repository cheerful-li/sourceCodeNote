// Copyright 2013 Julien Schmidt. All rights reserved.
// Based on the path package, Copyright 2009 The Go Authors.
// Use of this source code is governed by a BSD-style license that can be found
// at https://github.com/julienschmidt/httprouter/blob/master/LICENSE.

package gin

// cleanPath is the URL version of path.Clean, it returns a canonical URL path
// for p, eliminating . and .. elements.
//
// The following rules are applied iteratively until no further processing can
// be done:
//	1. Replace multiple slashes with a single slash.
//	2. Eliminate each . path name element (the current directory).
//	3. Eliminate each inner .. path name element (the parent directory)
//	   along with the non-.. element that precedes it.
//	4. Eliminate .. elements that begin a rooted path:
//	   that is, replace "/.." by "/" at the beginning of a path.
//
// If the result of this process is an empty string, "/" is returned.
func cleanPath(p string) string {
	const stackBufSize = 128
	// Turn empty string into "/"
	if p == "" {
		return "/"
	}

	// Reasonably sized buffer on stack to avoid allocations in the common case.
	// If a larger buffer is required, it gets allocated dynamically.
	// TODO: 了解下这种sized buffer, stack分配啥的
	buf := make([]byte, 0, stackBufSize)

	n := len(p)

	// Invariants:
	//      reading from path; r is index of next byte to process.
	//      writing to buf; w is index of next byte to write.

	// path must start with '/'
	r := 1 // 路径处理的字符游标
	w := 1 // buf下一个写入的字符游标位置（结果不包含w位置）

	// 路径不是以 /开头的情况， 把 r 置为 0， buf第一个字符置为/
	if p[0] != '/' {
		r = 0

		if n+1 > stackBufSize {
			buf = make([]byte, n+1)
		} else {
			buf = buf[:n+1]
		}
		buf[0] = '/'
	}
	// 最终路径是否有尾 /
	trailing := n > 1 && p[n-1] == '/'

	// A bit more clunky without a 'lazybuf' like the path package, but the loop
	// gets completely inlined (bufApp calls).
	// loop has no expensive function calls (except 1x make)		// So in contrast to the path package this loop has no expensive function
	// calls (except make, if needed).

	for r < n {
		switch {
		// 在switch的default里面统一添加 /,  这里可以处理掉多余的 /,   /a//b/c  -> /a/b/c
		case p[r] == '/':
			// empty path element, trailing slash is added after the end
			r++
		// 处理 /a/.的情况， 以.结尾，此时应该忽略 . 字符，并且因为for循环结束，不会走到下一次default里面添加/，因此设置 trailing = true，在循环结束后添加尾/
		case p[r] == '.' && r+1 == n:
			trailing = true
			r++
		// 处理 /a/./b的情况, 直接忽略了 ./就行
		// 处理 /a/./ 时，忽略了 ./, 并且for循环结束， trailing在初始化的时候已经置为了true
		case p[r] == '.' && p[r+1] == '/':
			// . element
			r += 2
		// 处理 /a/b/../c 或者 /a/b/.. 这种，   前者结果为 /a/c 后者为 /a
		case p[r] == '.' && p[r+1] == '.' && (r+2 == n || p[r+2] == '/'):
			// .. element: remove to last /
			// 需要回退删除到上上个 /
			r += 3

			if w > 1 {
				// can backtrack
				// 上上个 /
				w--
				// buf还没开始写，说明前面的字符和路径里面的相同，去p里面查找回退
				// w游标的位置在 / 的位置，考虑两种情况
				//   /a/b/..  -> /a, 回退后w为2，指向b前面的/位置，for循环结束，最终结果不包含w指向的字符
				//  /a/b/../  -> /a/ 回退后w为2， trailing在初始化的时候已经置为了true
				if len(buf) == 0 {
					for w > 1 && p[w] != '/' {
						w--
					}
				} else {
					for w > 1 && buf[w] != '/' {
						w--
					}
				}
			}

		default:
			// Real path element.
			// Add slash if needed
			// w为1时，buf已经包含有/了
			// 普通字符的前面先添加 /
			if w > 1 {
				bufApp(&buf, p, w, '/')
				w++
			}

			// Copy element
			// for把普通字符都消耗掉，直到下一个 /
			for r < n && p[r] != '/' {
				bufApp(&buf, p, w, p[r])
				w++
				r++
			}
		}
	}

	// Re-append trailing slash
	// 处理需要添加尾 /的情况
	if trailing && w > 1 {
		bufApp(&buf, p, w, '/')
		w++
	}

	// If the original string was not modified (or only shortened at the end),
	// return the respective substring of the original string.
	// Otherwise return a new string from the buffer.
	// 路径不需要清理，原封不动的情况下，buf是空的
	if len(buf) == 0 {
		return p[:w]
	}
	return string(buf[:w])
}

// Internal helper to lazily create a buffer if necessary.
// Calls to this function get inlined.
// 延迟创建buffer，直到字符串s的w位置的字符不是c的时候。
// 如果字符c一直和s的w位置的字符一致，那么最终buf都是空的， 只有当出现差异的时候，再出创建buf，并拷贝之前一致的那些字符
func bufApp(buf *[]byte, s string, w int, c byte) {
	b := *buf
	if len(b) == 0 {
		// No modification of the original string so far.
		// If the next character is the same as in the original string, we do
		// not yet have to allocate a buffer.
		if s[w] == c {
			// 让buf继续保持为空
			return
		}

		// Otherwise use either the stack buffer, if it is large enough, or
		// allocate a new buffer on the heap, and copy all previous characters.
		length := len(s)
		if length > cap(b) {
			*buf = make([]byte, length)
		} else {
			*buf = (*buf)[:length]
		}
		b = *buf
		// 前w个字符是一致的，一次性的拷贝进去
		copy(b, s[:w])
	}
	// 第w个字符，写进去
	b[w] = c
}
