// figma-kiwi — decode Figma's binary Kiwi protocol
//
// This library provides pure functions for decoding Figma's internal
// binary formats: the Kiwi wire protocol, scenegraph data, vector
// geometry (SVG paths), and CSS property extraction.

export {
  isFigWireFrame,
  extractCompressedSchema,
  isZstdCompressed,
} from './kiwi.mjs';

export {
  decodePage,
  nodeId,
  mergePages,
  buildTree,
  countByType,
  serializeScenegraph,
} from './scenegraph.mjs';

export {
  commandsBlobToPath,
  vectorNetworkBlobToPath,
  colorToHex,
  extractSvgs,
} from './svg.mjs';

export {
  rgbaToCSS,
  extractCSSFromKiwi,
  extractCSSFromAPI,
} from './css.mjs';
