var SourceMapConsumer = require('source-map').SourceMapConsumer
var pathFS = require('path')

var globalSymbolName = '@@redux-saga/LOCATION'

function getSourceCode (path){
  // use `toString` for babel v7, `getSource` for older versions
  const rawCode = Object.prototype.hasOwnProperty.call(path, 'toString') ? path.toString() : path.getSource();
  return rawCode.replace(/^(yield\*?)\s+/, '')
}

function getFilename(fileOptions, useAbsolutePath){
  if(useAbsolutePath){
    return fileOptions.filename
  }
  // babel v7 defines cwd. for v6 use fallback
  const cwd = fileOptions.cwd || process.cwd()
  return pathFS.relative(cwd, fileOptions.filename)
}

function isSaga (path){
  return path.node.generator;
}

module.exports = function(babel) {
  var { types: t, template } = babel
  var sourceMap = null
  var alreadyVisited = new WeakSet();

  var extendExpressionWithLocationTemplate = template(`
    Object.defineProperty(TARGET, SYMBOL_NAME, {
      value: {
        fileName: FILENAME,
        lineNumber: LINE_NUMBER,
        code: SOURCE_CODE,
      },
    });
  `);

  /**
   *  Genetares location descriptor
   */

  function createLocationExtender(node, useSymbol, location, sourceCode){
    const extendExpressionWithLocation = extendExpressionWithLocationTemplate({
        TARGET: node,
        SYMBOL_NAME: getSymbol(useSymbol),
        FILENAME: t.stringLiteral(location.fileName),
        LINE_NUMBER: t.numericLiteral(location.lineNumber),
        SOURCE_CODE: sourceCode ? t.stringLiteral(sourceCode) : t.nullLiteral(),
      })

    return extendExpressionWithLocation.expression;
  }

  function getSymbol(useSymbol) {
    return useSymbol === false
      ? t.stringLiteral(globalSymbolName)
      : t.callExpression(
        t.memberExpression(t.identifier('Symbol'), t.identifier('for')),
        [t.stringLiteral(globalSymbolName)]
      )
  }

  function calcLocation(loc, fileName) {
    var lineNumber = loc.start.line

    if (!sourceMap) {
      return {
        lineNumber: lineNumber,
        fileName: fileName,
      }
    }
    var mappedData = sourceMap.originalPositionFor({
      line: loc.start.line,
      column: loc.start.column,
    })

    return {
      lineNumber: mappedData.line,
      fileName: fileName + ' (' + mappedData.source + ')',
    }
  }

  var visitor = {
    Program: function(path, state) {
      // clean up state for every file
      sourceMap = state.file.opts.inputSourceMap ? new SourceMapConsumer(state.file.opts.inputSourceMap) : null
    },
    /**
     * attach location info object to saga
     *
     * @example
     * input
     *  function * effectHandler(){}
     * output
     *  function * effectHandler(){}
     *  Object.defineProperty(effectHandler, Symbol.for("@@redux-saga/LOCATION"), {
     *    value: { fileName: ..., lineNumber: ... }
     *  })
     */
    FunctionDeclaration(path, state) {
      if (!isSaga(path)) return

      var functionName = path.node.id.name
      var filename =  getFilename(state.file.opts, state.opts.useAbsolutePath)
      var locationData = calcLocation(path.node.loc, filename)

      const extendedDeclaration =  createLocationExtender(
        t.identifier(functionName),
        state.opts.useSymbol,
        locationData
      )

      // https://github.com/babel/babel/issues/4007
      if (path.parentPath.isExportDefaultDeclaration() || path.parentPath.isExportDeclaration()) {
        path.parentPath.insertAfter(extendedDeclaration)
      } else {
        path.insertAfter(extendedDeclaration)
      }
    },
    FunctionExpression(path, state) {
      var node = path.node

      if (!isSaga(path) || alreadyVisited.has(node)) return
      alreadyVisited.add(node);

      var filename =  getFilename(state.file.opts, state.opts.useAbsolutePath)
      var locationData = calcLocation(node.loc, filename);
      var sourceCode = getSourceCode(path);

      const extendedExpression = createLocationExtender(
        node,
        state.opts.useSymbol,
        locationData,
        sourceCode
      )

      path.replaceWith(extendedExpression)
    },
    /**
     * attach location info object to effect descriptor
     * ignores delegated yields
     *
     * @example
     * input
     *  yield call(smthelse)
     * output
     *  yield (function () {
     *    return Object.defineProperty(test1, Symbol.for("@@redux-saga/LOCATION"), {
     *      value: { fileName: ..., lineNumber: ... }
     *    })
     *  })()
     */
    YieldExpression(path, state) {
      var node = path.node
      var yielded = node.argument

      if (!node.loc || node.delegate) return
      if (!t.isCallExpression(yielded) && !t.isLogicalExpression(yielded)) return

      var filename =  getFilename(state.file.opts, state.opts.useAbsolutePath)
      var locationData = calcLocation(node.loc, filename)
      var sourceCode = getSourceCode(path);

      node.argument = createLocationExtender(
        yielded,
        state.opts.useSymbol,
        locationData,
        sourceCode
      )
    },
  }

  return {
    visitor,
  }
}
