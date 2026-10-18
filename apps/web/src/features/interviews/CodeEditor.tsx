import { useEffect, useRef, useState } from 'react';
import type { CodeLanguage } from '@cofoundry/shared';
import { TextAreaField } from '../../components/ui';

import type * as MonacoApi from 'monaco-editor/editor/editor.api';

type Monaco = typeof MonacoApi;

/**
 * Monaco editor (MIT, bundled locally and loaded only for the coding round). A plain text editor
 * is always available as an accessible fallback and is used automatically if Monaco cannot load.
 */
export function CodeEditor({
  value,
  language,
  onChange,
  label,
  resetToken = 0,
}: {
  value: string;
  /** Change to replace the editor text with `value`. */
  resetToken?: number;
  language: CodeLanguage;
  onChange: (code: string) => void;
  label: string;
}) {
  const host = useRef<HTMLDivElement | null>(null);
  const editor = useRef<ReturnType<Monaco['editor']['create']> | null>(null);
  const changeRef = useRef(onChange);
  const [mode, setMode] = useState<'loading' | 'monaco' | 'plain'>('loading');

  useEffect(() => {
    changeRef.current = onChange;
  });

  useEffect(() => {
    let disposed = false;
    import('./monaco-setup')
      .then(({ monaco }) => {
        if (disposed || !host.current) return;
        const dark = document.documentElement.classList.contains('dark');
        editor.current = monaco.editor.create(host.current, {
          value,
          language,
          theme: dark ? 'vs-dark' : 'vs',
          automaticLayout: true,
          minimap: { enabled: false },
          fontSize: 14,
          tabSize: language === 'python' ? 4 : 2,
          scrollBeyondLastLine: false,
          ariaLabel: label,
          accessibilitySupport: 'auto',
        });
        editor.current.onDidChangeModelContent(() =>
          changeRef.current(editor.current?.getValue() ?? ''),
        );
        setMode('monaco');
      })
      .catch(() => setMode('plain'));
    return () => {
      disposed = true;
      editor.current?.dispose();
      editor.current = null;
    };
    // The editor is created once; value/language changes are pushed below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const ed = editor.current;
    if (!ed) return;
    void import('./monaco-setup').then(({ monaco }) => {
      const model = ed.getModel();
      if (model) monaco.editor.setModelLanguage(model, language);
    });
  }, [language]);

  // The editor owns its text while typing (pushing React state back would race with fast
  // keystrokes). An explicit `resetToken` change replaces the text, e.g. a new starter code.
  const latestValue = useRef(value);
  useEffect(() => {
    latestValue.current = value;
  });
  useEffect(() => {
    const ed = editor.current;
    if (ed && ed.getValue() !== latestValue.current) ed.setValue(latestValue.current);
  }, [resetToken]);

  return (
    <div className="flex flex-col gap-2">
      {mode === 'plain' ? (
        <TextAreaField
          label={label}
          value={value}
          spellCheck={false}
          className="min-h-80 font-mono text-sm"
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <div
          ref={host}
          data-testid="code-editor"
          className="h-80 overflow-hidden rounded-lg border border-line-strong sm:h-96"
          aria-busy={mode === 'loading'}
        />
      )}
      {mode === 'monaco' ? (
        <button
          type="button"
          className="self-start text-sm text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink"
          onClick={() => {
            editor.current?.dispose();
            editor.current = null;
            setMode('plain');
          }}
        >
          Use a plain text editor instead (screen-reader friendly)
        </button>
      ) : null}
    </div>
  );
}
