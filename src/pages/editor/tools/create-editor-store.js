/**
 * 创建单个编辑会话的界面与保存状态仓库，便于组件订阅而不直接读写正文。
 * 文档编辑序号用于判断待保存变更；纸张先克隆，防止直接复用持久记录对象导致外部状态被修改。
 */
import { createStore } from "zustand/vanilla"
import { readFormattingMarks } from "./formatting-marks-preferences.js"
import { validatePageSettings } from "./page-settings.js"

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
    // 会话阻塞与界面偏好单独保存：切换/只读控制入口权限，缩放和面板状态不属于文档快照。
    readOnly: false,
    switching: false,
    zoom: 1,
    fitWidth: false,
    // DOM 实测的页布局只属于当前视图，不写入文档、保存序号或正文撤销历史。
    pagination: null,
    outlineOpen: true,
    searchOpen: false,
    commentsOpen: false,
    formattingMarks: readFormattingMarks(),
    activeTab: "开始",
    // 标题、纸张、正文三个写入口都增加 revision 并标为待保存，保存队列据此判断是否有新变更。
    updateTitle: title => set(state => ({ title, revision: state.revision + 1, saveStatus: "dirty" })),
    // 完整页配置先验证再克隆，防止关闭设置弹窗后继续修改草稿中的边距/水印影响已提交页面。
    // 页面只属于保存状态，不发送正文事务，因此不会混入 Tiptap 的文字撤销栈。
    updatePage: page => {
      const snapshot = structuredClone(validatePageSettings(page))
      set(state => ({ page: snapshot, revision: state.revision + 1, saveStatus: "dirty" }))
    },
    updateContent: () => set(state => ({ revision: state.revision + 1, saveStatus: "dirty" })),
    // 界面更新不增加编辑序号；调用方只应传入布局、焦点或会话状态等界面字段。
    updateView: values => set(values),
    // 把保存协调器的确认序号和错误回显到 UI；存储版本仍由保存队列持有，避免混淆两种版本。
    updateSave: ({ status, savedRevision, error }) => set({
      saveStatus: status,
      savedRevision,
      saveError: error ? error.message : ""
    })
  }))
}
