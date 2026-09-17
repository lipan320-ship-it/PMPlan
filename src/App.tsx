const milestones = [
  { id: "M1", label: "离线桌面壳", state: "进行中" },
  { id: "M2", label: "数据内核", state: "待开始" },
  { id: "M3", label: "可用时间板", state: "待开始" },
];

function TimelineIcon() {
  return (
    <svg
      aria-hidden="true"
      className="brand-mark__icon"
      viewBox="0 0 24 24"
      fill="none"
    >
      <path d="M5 6h14M5 12h9M5 18h14" stroke="currentColor" strokeWidth="2" />
      <circle cx="16.5" cy="12" r="2.5" fill="currentColor" />
    </svg>
  );
}

export function App() {
  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-mark">
          <span className="brand-mark__tile">
            <TimelineIcon />
          </span>
          <span>
            <strong>工作规划时间板</strong>
            <small>LOCAL PLANNER</small>
          </span>
        </div>
        <span className="offline-badge">
          <span aria-hidden="true" className="offline-badge__dot" />
          本地离线模式
        </span>
      </header>

      <section className="workspace" aria-labelledby="welcome-title">
        <div className="welcome-card">
          <p className="eyebrow">工程基线 · M1</p>
          <h1 id="welcome-title">规划空间正在准备中</h1>
          <p className="welcome-card__lead">
            桌面运行壳已经建立。下一里程碑将接入本地 SQLite，随后开放任务时间板。
          </p>

          <div className="milestone-grid" aria-label="近期里程碑">
            {milestones.map((milestone) => (
              <article className="milestone-card" key={milestone.id}>
                <div>
                  <span className="milestone-card__id">{milestone.id}</span>
                  <h2>{milestone.label}</h2>
                </div>
                <span
                  className={
                    milestone.state === "进行中"
                      ? "status-pill status-pill--active"
                      : "status-pill"
                  }
                >
                  {milestone.state}
                </span>
              </article>
            ))}
          </div>

          <div className="privacy-note">
            <span aria-hidden="true">✓</span>
            当前页面不请求网络，也不会上传规划数据。
          </div>
        </div>
      </section>
    </main>
  );
}
