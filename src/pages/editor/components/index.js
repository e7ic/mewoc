/**
 * 编辑页对外的组件出口：页面只依赖 Provider 与工作区两个公开入口。
 * 内部工具栏和弹窗按职责互相引用，避免把所有组件暴露给页面装配层。
 */
export { EditorProvider } from "./EditorProvider.jsx"
export { EditorWorkspace } from "./EditorWorkspace.jsx"
