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

ReactDOM.render(
  <EditorThemeProvider sync>
    <EditorPage />
  </EditorThemeProvider>,
  document.getElementById("root")
)
