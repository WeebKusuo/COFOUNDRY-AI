// Loaded lazily (dynamic import) only when the coding round opens. The CSP nonce hook must be
// installed before Monaco creates its runtime <style> elements, so its side-effect module is the
// first import (imports evaluate in order; statements between them would run after all of them).
import '../../lib/csp-nonce-install';
import * as monaco from 'monaco-editor/editor/editor.api';
import 'monaco-editor/languages/definitions/javascript/register';
import 'monaco-editor/languages/definitions/python/register';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';

(self as unknown as { MonacoEnvironment: { getWorker: () => Worker } }).MonacoEnvironment = {
  // Only the generic editor worker is bundled (bundled locally, same origin; no CDN, no language
  // servers).
  getWorker: () => new EditorWorker(),
};

export { monaco };
