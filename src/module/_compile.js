import { extname, resolve } from "../safe/path.js"

import ENTRY from "../constant/entry.js"
import PACKAGE from "../constant/package.js"
import SOURCE_TYPE from "../constant/source-type.js"

import Compiler from "../caching-compiler.js"
import Module from "../module.js"
import Runtime from "../runtime.js"

import captureStackTrace from "../error/capture-stack-trace.js"
import createSourceMap from "../util/create-source-map.js"
import encodeURI from "../util/encode-uri.js"
import getSourceMappingURL from "../util/get-source-mapping-url.js"
import getURLFromFilePath from "../util/get-url-from-file-path.js"
import isError from "../util/is-error.js"
import isInspect from "../env/is-inspect.js"
import isMJS from "../util/is-mjs.js"
import isObjectEmpty from "../util/is-object-empty.js"
import isStackTraceMasked from "../util/is-stack-trace-masked.js"
import maskStackTrace from "../error/mask-stack-trace.js"
import moduleState from "./state.js"
import readFile from "../fs/read-file.js"
import readFileFast from "../fs/read-file-fast.js"
import shared from "../shared.js"
import validateESM from "./esm/validate.js"
import warn from "../warn.js"
import wrap from "./wrap.js"

const {
  STATE_EXECUTION_STARTED,
  STATE_PARSING_STARTED,
  TYPE_ESM
} = ENTRY

const {
  OPTIONS_MODE_ALL,
  OPTIONS_MODE_AUTO
} = PACKAGE

const {
  MODULE,
  SCRIPT,
  UNAMBIGUOUS
} = SOURCE_TYPE

const ExObject = __external__.Object

function compile(caller, entry, content, filename, fallback) {
  const { options } = entry.package

  let hint = SCRIPT
  let sourceType = SCRIPT

  if (extname(filename) === ".mjs") {
    hint = MODULE
    sourceType = MODULE
  } else if (options.mode === OPTIONS_MODE_ALL) {
    sourceType = MODULE
  } else if (options.mode === OPTIONS_MODE_AUTO) {
    sourceType = UNAMBIGUOUS
  }

  const pkg = entry.package
  const { cache } = pkg
  const { cacheName } = entry

  let { compileData } = entry

  if (cache.compile[cacheName] === true) {
    compileData = Compiler.from(entry)

    if (compileData) {
      compileData.code = readCachedCode(resolve(pkg.cachePath, cacheName))
    } else {
      Reflect.deleteProperty(cache.compile, cacheName)
      Reflect.deleteProperty(cache.map, cacheName)
    }
  }

  if (! compileData) {
    compileData = Compiler.from(entry)

    if (! compileData ||
        compileData.changed) {
      const scriptData = compileData
        ? compileData.scriptData
        : null

      compileData = tryCompileCode(caller, entry, content, {
        hint,
        sourceType
      })

      compileData.scriptData = scriptData
    } else {
      compileData.code = content
    }
  }

  if (options.warnings &&
      shared.parsing) {
    for (const warning of compileData.warnings) {
      warn(warning.code, filename, ...warning.args)
    }
  }

  if (shared.parsing) {
    const defaultPkg = shared.package.default
    const isESM = entry.type === TYPE_ESM
    const { parent } = entry
    const parentPkg = parent && parent.package
    const parentIsESM = parent && parent.type === TYPE_ESM

    if (! isESM &&
        ! parentIsESM &&
        (pkg === defaultPkg ||
         parentPkg === defaultPkg)) {
      return fallback ? fallback() : void 0
    }

    if (isESM &&
        entry.state === STATE_PARSING_STARTED) {
      tryValidateESM(caller, entry)
    }
  } else {
    entry.state = STATE_EXECUTION_STARTED
    return tryCompileCached(entry)
  }
}

function tryCompileCached(entry) {
  const isESM = entry.type === TYPE_ESM
  const noDepth = moduleState.requireDepth === 0
  const tryCompile = isESM ? tryCompileESM : tryCompileCJS

  if (noDepth) {
    moduleState.stat = { __proto__: null }
  }

  let result

  if (entry.package.options.debug) {
    result = tryCompile(entry)

    if (noDepth) {
      moduleState.stat = null
    }
  } else {
    try {
      result = tryCompile(entry)
    } catch (e) {
      if (! isError(e) ||
          isStackTraceMasked(e)) {
        throw e
      }

      const { filename } = entry.module
      const content = () => readSourceCode(filename)

      throw maskStackTrace(e, content, filename, isESM)
    } finally {
      if (noDepth) {
        moduleState.stat = null
      }
    }
  }

  return result
}

function tryCompileCJS(entry) {
  const { compileData, runtimeName } = entry
  const mod = entry.module
  const useAsync = useAsyncWrapper(entry)

  if (Module.wrap === moduleWrapESM) {
    Module.wrap = wrap
  }

  let content = compileData.code

  if (compileData.changed) {
    content =
      "const " + runtimeName + "=this;" +
      (compileData.topLevelReturn ? "return " : "") +
      runtimeName + ".r((" +
      (useAsync ? "async " :  "") +
      "function(global,exports,require){" +
      content +
      "\n}))"

    Runtime.enable(entry, new ExObject)
  } else if (useAsync) {
    Module.wrap = moduleWrapAsyncCJS
  }

  content += maybeSourceMap(entry, content)

  try {
    return mod._compile(content, mod.filename)
  } finally {
    if (Module.wrap === moduleWrapAsyncCJS) {
      Module.wrap = wrap
    }
  }
}

function tryCompileESM(entry) {
  const { compileData, runtimeName } = entry
  const mod = entry.module
  const { filename } = mod

  const cjsVars =
    entry.package.options.cjs.vars &&
    ! isMJS(filename)

  let content =
    "const " + runtimeName + "=this;" +
    (compileData.topLevelReturn ? "return " : "") +
    runtimeName + ".r((" +
    (useAsyncWrapper(entry) ? "async " :  "") +
    "function(global" +
    (cjsVars ? ",exports,require" : "") +
    '){"use strict";' +
    compileData.code +
    "\n}))"

  content += maybeSourceMap(entry, content)

  if (! entry.url) {
    entry.url = getURLFromFilePath(filename)
  }

  if (! cjsVars) {
    Module.wrap = moduleWrapESM
  }

  Runtime.enable(entry, new ExObject)

  try {
    return mod._compile(content, filename)
  } finally {
    if (Module.wrap === moduleWrapESM) {
      Module.wrap = wrap
    }
  }
}

function moduleWrapAsyncCJS(script) {
  Module.wrap = wrap
  return "(async function (exports, require, module, __filename, __dirname) { " +
    script + "\n});"
}

function moduleWrapESM(script) {
  Module.wrap = wrap
  return "(function () { " + script + "\n});"
}

function maybeSourceMap(entry, content) {
  const { sourceMap } = entry.package.options

  if (sourceMap !== false &&
     (sourceMap || isInspect()) &&
      ! getSourceMappingURL(content)) {
    return "//# sourceMappingURL=data:application/json;charset=utf-8," +
      encodeURI(createSourceMap(entry.module.filename, content))
  }

  return ""
}

function readCachedCode(filename) {
  return readFileFast(filename, "utf8")
}

function readSourceCode(filename) {
  return readFile(filename, "utf8")
}

function tryCompileCode(caller, entry, content, options) {
  if (entry.package.options.debug) {
    return Compiler.compile(entry, content, options)
  }

  let error

  try {
    return Compiler.compile(entry, content, options)
  } catch (e) {
    error = e
  }

  if (! isError(error) ||
      isStackTraceMasked(error)) {
    throw error
  }

  const isESM = error.sourceType === MODULE

  Reflect.deleteProperty(error, "sourceType")
  captureStackTrace(error, caller)
  throw maskStackTrace(error, content, entry.module.filename, isESM)
}

function tryValidateESM(caller, entry) {
  if (entry.package.options.debug) {
    return validateESM(entry)
  }

  let error

  try {
    return validateESM(entry)
  } catch (e) {
    error = e
  }

  if (! isError(error) ||
      isStackTraceMasked(error)) {
    throw error
  }

  const { filename } = entry.module
  const content = () => readSourceCode(filename)

  captureStackTrace(error, caller)
  throw maskStackTrace(error, content, filename, true)
}

function useAsyncWrapper(entry) {
  const pkg = entry.package

  if (pkg.options.await &&
      shared.support.await) {
    if (entry.type !== TYPE_ESM) {
      return true
    }

    if (isMJS(entry.module)) {
      return false
    }

    const { exportSpecifiers } = entry.compileData

    if (! exportSpecifiers ||
        isObjectEmpty(exportSpecifiers)) {
      return true
    }
  }

  return false
}

export default compile
