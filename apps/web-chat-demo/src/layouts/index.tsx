import { Link, Outlet } from 'umi';
import styles from './index.less';

export default function Layout() {
  return (
    <div className={styles.navs}>
      <ul>
        <li>
          <Link to="/">Home</Link>
        </li>
        <li>
          <Link to="/docs">Docs</Link>
        </li>
        <li>
          <Link to="/chat">Chat UI</Link>
        </li>
        <li>
          <Link to="/chat-sdk">AI Chat SDK</Link>
        </li>
        <li>
          <Link to="/chat-agent">AI Agent Chat</Link>
        </li>
        <li>
          <Link to="/chat-agent-graph">AI Agent Graph</Link>
        </li>
        <li>
          <a href="https://github.com/umijs/umi">Github</a>
        </li>
      </ul>
      <Outlet />
    </div>
  );
}
