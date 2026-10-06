/**
 * 应用挂载入口：载入组件库与正文公共样式，并为编辑页面建立统一中文环境和主题。
 * 独立消息容器也使用同一主题 Provider，使弹窗提示能跟随主界面的主题偏好。
 */
import ReactDOM from "react-dom"
import { ConfigProvider } from "antd"
import EditorPage from "./pages/editor/EditorPage.jsx"
import { EditorThemeProvider } from "./pages/editor/components/EditorThemeProvider.jsx"
import "antd/dist/reset.css"
import "./assets/style/common.scss"

// 静态消息与确认框拥有独立 React 容器，需要显式接入中文和主题。
ConfigProvider.config({
  holderRender: children => <EditorThemeProvider>{children}</EditorThemeProvider>
})

// 只有主界面的 Provider 开启全局同步，负责系统主题监听与根节点主题属性。
// 此入口将整个编辑应用挂到现有 root 节点，不在每个子组件中重复初始化。
ReactDOM.render(
  <EditorThemeProvider sync>
    <EditorPage />
  </EditorThemeProvider>,
  document.getElementById("root")
)
