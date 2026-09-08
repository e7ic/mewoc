import { createStore } from "zustand/vanilla"

/**
 * 按会话创建 store，避免多编辑器共享状态；正文和选区由 Tiptap 单独拥有。
 * revision 只跟踪标题、纸张和正文修改，界面缩放、面板开关等不触发文档保存。
 * 未入库的新建/导入文档从 revision 1 开始，使首次挂载也会安排一次保存。
 */
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
