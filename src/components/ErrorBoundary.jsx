import React from 'react';

/**
 * 页面出错兜底：某一页渲染出错时只把这一页换成提示，不让整个窗口白屏；
 * 后台的下载、去重、草稿任务都在主进程里，不受影响。
 */
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error, info) {
    console.error('[页面出错]', error, info?.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="page-error" role="alert">
        <h3>这一页出了点问题</h3>
        <p>后台正在进行的下载和处理不受影响。点下面的按钮重新加载这一页。</p>
        <div className="page-error-actions">
          <button className="btn btn-primary" onClick={() => this.setState({ failed: false })}>
            重新加载这一页
          </button>
          <button className="btn btn-outline" onClick={() => window.location.reload()}>
            重新加载整个窗口
          </button>
        </div>
      </div>
    );
  }
}
