import { useCallback, useEffect, useRef } from "react"
import { createSaveCoordinator } from "../tools/save-coordinator.js"
import { getReferencedAssetIds, validateDocument } from "../tools/document-schema.js"
import { saveLocalDocument } from "../tools/local-repository.js"

export function useDocumentSave(editor, record, assets, store) {
  const coordinatorRef = useRef(null)

  const getSnapshot = useCallback(() => {
    const state = store.getState()
    const content = editor.getJSON()
    const references = getReferencedAssetIds(content).map(id => {
      const asset = assets.get(id)
      if (!asset) throw new Error("图片尚未就绪，请稍后保存")
      return { id, fileName: asset.fileName, mimeType: asset.mimeType, byteLength: asset.byteLength }
    })
    return validateDocument({
      ...record.document,
      title: state.title,
      page: structuredClone(state.page),
      content,
      assets: references,
      updatedAt: new Date().toISOString()
    })
  }, [editor, record, assets, store])

  const saveDocument = useCallback(() => coordinatorRef.current?.flush() ?? Promise.resolve(false), [])

  useEffect(() => {
    if (!editor) return
    const coordinator = createSaveCoordinator({
      getSnapshot,
      getRevision: () => store.getState().revision,
      write: (snapshot, version) => saveLocalDocument(snapshot, assets, version),
      onStatus: state => store.getState().updateSave(state),
      baseVersion: record.storageVersion,
      initialRevision: 0
    })
    coordinatorRef.current = coordinator
    const unsubscribe = store.subscribe((state, previous) => {
      if (state.revision !== previous.revision) coordinator.schedule()
    })
    if (store.getState().revision) coordinator.schedule()
    const handleBeforeUnload = event => {
      const state = store.getState()
      if (state.revision === state.savedRevision) return
      event.preventDefault()
      event.returnValue = ""
    }
    window.addEventListener("beforeunload", handleBeforeUnload)
    return () => {
      unsubscribe()
      coordinator.dispose()
      coordinatorRef.current = null
      window.removeEventListener("beforeunload", handleBeforeUnload)
    }
  }, [editor, getSnapshot, assets, record, store])

  return { getSnapshot, saveDocument }
}
