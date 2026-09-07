import { createStore } from "zustand/vanilla"

export function createEditorStore(record) {
  return createStore(set => ({
    title: record.document.title,
    page: structuredClone(record.document.page),
    revision: record.storageVersion ? 0 : 1,
    savedRevision: 0,
    saveStatus: record.storageVersion ? "saved" : "dirty",
    saveError: "",
    readOnly: false,
    switching: false,
    zoom: 1,
    fitWidth: false,
    outlineOpen: true,
    searchOpen: false,
    activeTab: "开始",
    updateTitle: title => set(state => ({ title, revision: state.revision + 1, saveStatus: "dirty" })),
    updatePage: page => set(state => ({ page, revision: state.revision + 1, saveStatus: "dirty" })),
    updateContent: () => set(state => ({ revision: state.revision + 1, saveStatus: "dirty" })),
    updateView: values => set(values),
    updateSave: ({ status, savedRevision, error }) => set({
      saveStatus: status,
      savedRevision,
      saveError: error ? error.message : ""
    })
  }))
}
