import { createContext, useContext, useEffect, useMemo, useState } from "react"
import { useEditor } from "@tiptap/react"
import { useStore } from "zustand"
import { createExtensions } from "../tools/create-extensions.js"
import { createEditorStore } from "../tools/create-editor-store.js"
import { useDocumentSave } from "../hooks/use-document-save.js"
import { useDocumentImages } from "../hooks/use-document-images.js"
import { useEditorInput, cleanPastedHtml } from "../hooks/use-editor-input.js"

export const EditorContext = createContext(null)

export function EditorProvider({ record, children }) {
  const [store] = useState(() => createEditorStore(record))
  const [assets] = useState(() => record.assets)
  const readOnly = useStore(store, state => state.readOnly || state.switching)
  const editor = useEditor({
    extensions: createExtensions(id => assets.get(id)?.url || ""),
    content: record.document.content,
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: { class: "mewoc-content", role: "textbox", "aria-label": "文档正文", "aria-multiline": "true", spellcheck: "false" },
      transformPastedHTML: html => cleanPastedHtml(html, id => assets.has(id))
    },
    onUpdate: () => store.getState().updateContent()
  })
  const { getSnapshot, saveDocument } = useDocumentSave(editor, record, assets, store)
  const { insertImages, uploading } = useDocumentImages(editor, assets, store)
  useEditorInput(editor, store, insertImages, saveDocument)

  useEffect(() => {
    return () => assets.forEach(asset => URL.revokeObjectURL(asset.url))
  }, [assets])

  useEffect(() => {
    editor?.setEditable(!readOnly, false)
    if (readOnly) editor?.commands.clearFormat()
  }, [editor, readOnly])

  const value = useMemo(() => ({ editor, store, assets, getSnapshot, saveDocument, insertImages, uploading }),
    [editor, store, assets, getSnapshot, saveDocument, insertImages, uploading])

  return <EditorContext.Provider value={value}>{children}</EditorContext.Provider>
}

export function useDocumentEditor() {
  const context = useContext(EditorContext)
  if (!context) throw new Error("编辑器组件必须位于 EditorProvider 内")
  return context
}

export function useEditorStore(selector) {
  const { store } = useDocumentEditor()
  return useStore(store, selector)
}
