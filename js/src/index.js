// NiceText: browser-safe core entrypoint.
export const VERSION = '0.1.0';

export { BitReader, BitWriter } from './bitstream.js';
export { mulberry32 } from './random.js';
export { streamWrap, streamUnwrap, escapeBytes, unescapeBytes, EOF_MARKER_BYTES } from './stream.js';
export { tokenize, tokenizeArray, TOKEN } from './lexer.js';
export { loadDictionary, wrapDictionaryFromSAB, lookupWord, lookupType, lookupTypeByName, readTreeNode, TREE_NO_NODE, dictStats } from './dictionary.js';
export { weightedTypeStream, roundRobinTypeStream } from './typestream.js';
export { encode, typeStreamAsModelStream } from './encode.js';
export { decode } from './decode.js';
export { parseGrammar } from './grammar/parser.js';
export { loadGrammar, makeModel, modelStream, wrapGrammarFromSAB, grammarStats } from './grammar/expand.js';
export { createFormatter } from './grammar/format.js';
export { emitMRules } from './grammar/expgram.js';
export { loadModelTable, modelTableStream, tableIsCompatibleWithDict, wrapModelTableFromSAB, modelTableStats } from './modeltable.js';
export { generateModelTable } from './builder/genmodel.js';
export { encodeJob, decodeJob, loadResource } from './worker/jobs.js';
export { createWorker, defaultPoolSize } from './worker/spawn.js';
