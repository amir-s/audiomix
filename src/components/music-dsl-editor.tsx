import type { CSSProperties, ComponentProps, KeyboardEventHandler } from "react"

import Editor from "react-simple-code-editor"
import Prism from "prismjs"

import { cn } from "@/lib/utils"

const MUSIC_DSL_LANGUAGE = "music-dsl"

const musicDslGrammar: Prism.Grammar = {
  "state-name": {
    pattern: /(^[ \t]*)[A-Za-z_][A-Za-z0-9_]*(?=\s*:)/m,
    lookbehind: true,
    alias: "keyword",
  },
  label: {
    pattern: /\{[A-Za-z][A-Za-z0-9]*\}/,
    alias: "symbol",
  },
  number: /\b\d+\b/,
  operator: /[+*!]/,
  punctuation: /[():]/,
}

if (!Prism.languages[MUSIC_DSL_LANGUAGE]) {
  Prism.languages[MUSIC_DSL_LANGUAGE] = musicDslGrammar
}

const editorStyle = {
  fontFamily: "var(--app-font-mono)",
  fontSize: 12,
  lineHeight: 1.5,
} satisfies CSSProperties

type EditorOnKeyDown = ComponentProps<typeof Editor>["onKeyDown"]

type MusicDslEditorProps = {
  className?: string
  id: string
  onChange: (value: string) => void
  onKeyDown?: KeyboardEventHandler<HTMLTextAreaElement>
  placeholder?: string
  value: string
}

export function MusicDslEditor({
  className,
  id,
  onChange,
  onKeyDown,
  placeholder,
  value,
}: MusicDslEditorProps) {
  return (
    <Editor
      className={cn(
        "music-dsl-editor min-h-40 w-full rounded-md border border-input bg-background text-foreground shadow-xs transition-colors focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30",
        className
      )}
      highlight={(code) =>
        Prism.highlight(code, Prism.languages[MUSIC_DSL_LANGUAGE], MUSIC_DSL_LANGUAGE)
      }
      onKeyDown={onKeyDown as EditorOnKeyDown}
      onValueChange={onChange}
      padding={12}
      placeholder={placeholder}
      preClassName="music-dsl-editor__pre"
      style={editorStyle}
      tabSize={2}
      textareaClassName="music-dsl-editor__textarea"
      textareaId={id}
      value={value}
    />
  )
}
