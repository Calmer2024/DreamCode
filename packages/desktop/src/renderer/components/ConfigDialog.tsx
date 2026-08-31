import {
  AlertTriangle,
  ArrowLeft,
  Bot,
  ChevronDown,
  PlugZap,
  Plus,
  Puzzle,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Settings,
  Star,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type {
  CredentialAction,
  DesktopApi,
  DesktopBootstrap,
  DesktopSkillSnapshot,
  ProfileConnectionResult,
  SkillInstallRequest,
} from "../../shared/contracts";
import { ProviderIcon } from "./ProviderIcon";
import { SelectMenu } from "./SelectMenu";

interface ConfigDialogProps {
  api: DesktopApi;
  bootstrap: DesktopBootstrap;
  open: boolean;
  onClose: () => void;
  onSaved?: (bootstrap: DesktopBootstrap) => void;
  activeProfileId?: string;
  onApplyProfile?: (profileId: string) => void;
  initialSection?: "general" | "model" | "skills";
  workspaceRoot?: string;
}

const customModelValue = "__custom__";

interface ProfileForm {
  alias: string;
  provider: string;
  modelChoice: string;
  customModel: string;
  baseURL: string;
  credentialMode: "inline" | "environment" | "none";
  apiKey: string;
  apiKeyEnv: string;
}

export function ConfigDialog({
  api,
  bootstrap,
  open,
  onClose,
  onSaved,
  activeProfileId,
  onApplyProfile,
  initialSection = "model",
  workspaceRoot,
}: ConfigDialogProps) {
  const initialId =
    bootstrap.profiles.find((profile) => profile.id === activeProfileId)?.id ??
    bootstrap.currentProfileId ??
    bootstrap.profiles[0]?.id;
  const [section, setSection] = useState<"general" | "model" | "skills">(initialSection);
  const [selectedId, setSelectedId] = useState<string | undefined>(initialId);
  const selectedProfile = bootstrap.profiles.find((profile) => profile.id === selectedId);
  const [form, setForm] = useState<ProfileForm>(() => formForProfile(bootstrap, selectedProfile));
  const [baseline, setBaseline] = useState(() => JSON.stringify(form));
  const [saving, setSaving] = useState(false);
  const [operating, setOperating] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string>();
  const [testResult, setTestResult] = useState<ProfileConnectionResult>();
  const [confirmation, setConfirmation] = useState<
    { type: "discard"; action: () => void } | { type: "delete"; action: () => void | Promise<void> }
  >();
  const dirty = JSON.stringify(form) !== baseline;
  const preset = bootstrap.presets.find((item) => item.id === form.provider);
  const presetModels = useMemo(() => preset?.models ?? [], [preset]);
  const model = (
    form.modelChoice === customModelValue ? form.customModel : form.modelChoice
  ).trim();

  useEffect(() => {
    if (selectedId === undefined) return;
    if (selectedId && bootstrap.profiles.some((profile) => profile.id === selectedId)) return;
    const nextId = bootstrap.currentProfileId ?? bootstrap.profiles[0]?.id;
    const next = formForProfile(
      bootstrap,
      bootstrap.profiles.find((profile) => profile.id === nextId),
    );
    setSelectedId(nextId);
    setForm(next);
    setBaseline(JSON.stringify(next));
  }, [bootstrap, selectedId]);

  if (!open) return null;

  const loadProfile = (profileId: string | undefined) => {
    const action = () => {
      const next = formForProfile(
        bootstrap,
        bootstrap.profiles.find((profile) => profile.id === profileId),
      );
      setSelectedId(profileId);
      setForm(next);
      setBaseline(JSON.stringify(next));
      setError(undefined);
      setTestResult(undefined);
      if (profileId) onApplyProfile?.(profileId);
    };
    if (dirty) setConfirmation({ type: "discard", action });
    else action();
  };

  const leave = (action: () => void) => {
    if (dirty) setConfirmation({ type: "discard", action });
    else action();
  };

  const save = async () => {
    const validationError = validateForm(bootstrap, form, selectedId, model);
    if (validationError) {
      setError(validationError);
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      const request = {
        alias: form.alias.trim(),
        provider: form.provider,
        model,
        baseURL: optional(form.baseURL),
        credential: credentialAction(form, selectedProfile),
      };
      const updated = selectedId
        ? await api.updateProfile({ ...request, profileId: selectedId })
        : await api.createProfile(request);
      const savedProfile = selectedId
        ? updated.profiles.find((profile) => profile.id === selectedId)
        : updated.profiles.find(
            (profile) =>
              profile.provider === form.provider &&
              profile.alias.toLocaleLowerCase() === form.alias.trim().toLocaleLowerCase(),
          );
      const next = formForProfile(updated, savedProfile);
      setSelectedId(savedProfile?.id);
      setForm(next);
      setBaseline(JSON.stringify(next));
      onSaved?.(updated);
    } catch {
      setError("配置保存失败，请检查别名和字段后重试。");
    } finally {
      setSaving(false);
    }
  };

  const testConnection = async () => {
    const validationError = validateForm(bootstrap, form, selectedId, model);
    if (validationError) {
      setError(validationError);
      return;
    }
    setTesting(true);
    setError(undefined);
    setTestResult(undefined);
    try {
      setTestResult(
        await api.testProfile({
          profileId: selectedId,
          alias: form.alias.trim(),
          provider: form.provider,
          model,
          baseURL: optional(form.baseURL),
          credential: credentialAction(form, selectedProfile),
        }),
      );
    } catch {
      setTestResult({
        ok: false,
        code: "server_error",
        message: "连接测试失败，请稍后重试。",
      });
    } finally {
      setTesting(false);
    }
  };

  const selectProvider = (provider: string) => {
    const nextPreset = bootstrap.presets.find((item) => item.id === provider);
    setForm((current) => ({
      ...current,
      provider,
      modelChoice: nextPreset?.models?.[0]?.id ?? customModelValue,
      customModel: nextPreset?.models?.length ? "" : (nextPreset?.defaultModel ?? ""),
      baseURL: nextPreset?.defaultBaseURL ?? "",
    }));
    setTestResult(undefined);
  };

  return (
    <div className="settings-shell">
      <aside className="settings-nav">
        <button type="button" className="settings-back" onClick={() => leave(onClose)}>
          <ArrowLeft aria-hidden="true" />
          <span>返回应用</span>
        </button>
        <label className="settings-search">
          <Search aria-hidden="true" />
          <span className="sr-only">搜索设置</span>
          <input aria-label="搜索设置" placeholder="搜索设置…" />
        </label>
        <p>DreamCode</p>
        <button
          type="button"
          aria-current={section === "general" ? "page" : undefined}
          onClick={() => leave(() => setSection("general"))}
        >
          <Settings aria-hidden="true" />
          常规
        </button>
        <button
          type="button"
          aria-current={section === "model" ? "page" : undefined}
          onClick={() => setSection("model")}
        >
          <Bot aria-hidden="true" />
          模型
        </button>
        <button
          type="button"
          aria-current={section === "skills" ? "page" : undefined}
          onClick={() => leave(() => setSection("skills"))}
        >
          <Puzzle aria-hidden="true" />
          技能
        </button>
      </aside>

      <main className="settings-surface" aria-label="设置">
        <div className="settings-page-header" />
        <div className="settings-content">
          <header className="settings-content-header">
            <h1>{section === "general" ? "常规" : section === "model" ? "模型" : "技能"}</h1>
            <p>
              {section === "general"
                ? "运行行为与本地安全设置"
                : section === "model"
                  ? "配置 DreamCode 使用的模型服务"
                  : "管理 DreamCode 自动发现的技能"}
            </p>
          </header>
          {section === "general" ? (
            <GeneralSettings api={api} bootstrap={bootstrap} onSaved={onSaved} />
          ) : section === "model" ? (
            <section className="settings-group model-settings-group">
              <h2>模型配置</h2>
              <div className="profile-manager">
                <aside className="profile-list" aria-label="模型配置列表">
                  <button
                    type="button"
                    className="profile-create"
                    onClick={() => loadProfile(undefined)}
                  >
                    <Plus aria-hidden="true" />
                    新建配置
                  </button>
                  <div className="profile-list-items">
                    {bootstrap.profiles.map((profile) => (
                      <button
                        type="button"
                        key={profile.id}
                        aria-current={profile.id === selectedId ? "true" : undefined}
                        onClick={() => loadProfile(profile.id)}
                      >
                        <ProviderIcon provider={profile.provider} />
                        <span>
                          <span>
                            {providerName(bootstrap, profile.provider)} · {profile.alias}
                          </span>
                          <small>{profile.model ?? "未选择模型"}</small>
                        </span>
                        <span className="profile-statuses">
                          {profile.id === activeProfileId ? (
                            <em data-status="active">使用中</em>
                          ) : null}
                          {profile.id === bootstrap.currentProfileId ? <em>默认</em> : null}
                        </span>
                      </button>
                    ))}
                  </div>
                </aside>

                <div className="settings-card profile-editor">
                  <div className="profile-editor-heading">
                    <ProviderIcon provider={form.provider} />
                    <span>{selectedId ? "编辑配置" : "新建配置"}</span>
                  </div>
                  <label>
                    配置别名
                    <input
                      aria-label="配置别名"
                      value={form.alias}
                      onChange={(event) => setForm({ ...form, alias: event.target.value })}
                    />
                  </label>
                  <div className="settings-field">
                    <span>提供商</span>
                    <SelectMenu
                      label="提供商"
                      value={form.provider}
                      disabled={Boolean(selectedId)}
                      options={bootstrap.presets.map((item) => ({
                        value: item.id,
                        label: item.displayName,
                        icon: <ProviderIcon provider={item.id} size="small" />,
                      }))}
                      onChange={selectProvider}
                    />
                  </div>
                  <div className="settings-field">
                    <span>模型</span>
                    <SelectMenu
                      label="模型"
                      value={form.modelChoice}
                      options={[
                        ...presetModels.map((item) => ({
                          value: item.id,
                          label: item.label ?? item.id,
                        })),
                        { value: customModelValue, label: "自定义模型" },
                      ]}
                      onChange={(modelChoice) => setForm({ ...form, modelChoice })}
                    />
                  </div>
                  {form.modelChoice === customModelValue ? (
                    <label>
                      自定义模型 ID
                      <input
                        aria-label="自定义模型 ID"
                        value={form.customModel}
                        onChange={(event) => setForm({ ...form, customModel: event.target.value })}
                      />
                    </label>
                  ) : null}
                  <label>
                    Base URL
                    <input
                      aria-label="Base URL"
                      value={form.baseURL}
                      onChange={(event) => setForm({ ...form, baseURL: event.target.value })}
                      placeholder="https://api.example.com/v1"
                    />
                  </label>

                  <fieldset className="credential-fields">
                    <legend>API Key</legend>
                    <div className="credential-tabs">
                      <button
                        type="button"
                        aria-pressed={form.credentialMode === "environment"}
                        onClick={() =>
                          setForm({ ...form, credentialMode: "environment", apiKey: "" })
                        }
                      >
                        环境变量
                      </button>
                      <button
                        type="button"
                        aria-pressed={form.credentialMode === "inline"}
                        onClick={() =>
                          setForm({ ...form, credentialMode: "inline", apiKeyEnv: "" })
                        }
                      >
                        本地保存
                      </button>
                    </div>
                    {form.credentialMode === "environment" ? (
                      <label>
                        环境变量名称
                        <input
                          aria-label="API Key 环境变量"
                          value={form.apiKeyEnv}
                          onChange={(event) => setForm({ ...form, apiKeyEnv: event.target.value })}
                          placeholder="OPENAI_API_KEY"
                        />
                      </label>
                    ) : null}
                    {form.credentialMode === "inline" ? (
                      <label>
                        新的 API Key
                        <input
                          aria-label="新的 API Key"
                          type="password"
                          autoComplete="new-password"
                          value={form.apiKey}
                          onChange={(event) => setForm({ ...form, apiKey: event.target.value })}
                          placeholder={
                            selectedProfile?.credentialSource === "inline"
                              ? "留空以保留现有 Key"
                              : "输入 API Key"
                          }
                        />
                      </label>
                    ) : null}
                    {selectedProfile?.credentialAvailable ? (
                      <p className="configured-state">当前凭证可用</p>
                    ) : null}
                    {form.credentialMode !== "none" ? (
                      <button
                        type="button"
                        className="credential-clear"
                        onClick={() =>
                          setForm({
                            ...form,
                            credentialMode: "none",
                            apiKey: "",
                            apiKeyEnv: "",
                          })
                        }
                      >
                        清除凭证
                      </button>
                    ) : null}
                    <p className="storage-warning">
                      <AlertTriangle aria-hidden="true" />
                      本地保存的 API Key 将以明文写入 DreamCode 配置文件，建议优先使用环境变量。
                    </p>
                  </fieldset>

                  {testResult ? (
                    <p
                      className={
                        testResult.ok ? "connection-result success" : "connection-result error"
                      }
                    >
                      {testResult.message}
                    </p>
                  ) : null}
                  {error ? (
                    <p className="form-error" role="alert">
                      {error}
                    </p>
                  ) : null}
                  <footer className="profile-actions">
                    {selectedId ? (
                      <button
                        type="button"
                        className="profile-text-action danger"
                        disabled={operating}
                        onClick={() =>
                          setConfirmation({
                            type: "delete",
                            action: async () => {
                              setOperating(true);
                              setError(undefined);
                              try {
                                const updated = await api.deleteProfile(selectedId);
                                onSaved?.(updated);
                              } catch {
                                setError("配置删除失败，请稍后重试。");
                              } finally {
                                setOperating(false);
                              }
                            },
                          })
                        }
                      >
                        <Trash2 aria-hidden="true" />
                        删除
                      </button>
                    ) : (
                      <span />
                    )}
                    <div>
                      {selectedId && selectedId !== bootstrap.currentProfileId ? (
                        <button
                          type="button"
                          className="profile-text-action default"
                          disabled={operating}
                          onClick={() => {
                            setOperating(true);
                            setError(undefined);
                            void api
                              .setDefaultProfile(selectedId)
                              .then((updated) => onSaved?.(updated))
                              .catch(() => setError("设置默认配置失败，请稍后重试。"))
                              .finally(() => setOperating(false));
                          }}
                        >
                          <Star aria-hidden="true" />
                          设为默认
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="profile-text-action test"
                        disabled={testing}
                        onClick={() => void testConnection()}
                      >
                        <PlugZap aria-hidden="true" />
                        {testing ? "正在测试" : "测试连接"}
                      </button>
                      <button
                        type="button"
                        className="profile-text-action save"
                        disabled={saving}
                        onClick={() => void save()}
                      >
                        <Save aria-hidden="true" />
                        {saving ? "正在保存" : "保存"}
                      </button>
                    </div>
                  </footer>
                </div>
              </div>
            </section>
          ) : (
            <SkillManager api={api} workspaceRoot={workspaceRoot} />
          )}
        </div>
      </main>

      {confirmation ? (
        <div className="dialog-backdrop confirmation-backdrop" role="presentation">
          <section
            className="confirmation-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={confirmation.type === "delete" ? "删除配置" : "放弃未保存更改"}
          >
            <h2>{confirmation.type === "delete" ? "删除模型配置？" : "放弃未保存更改？"}</h2>
            <p>
              {confirmation.type === "delete"
                ? `${providerName(bootstrap, form.provider)} · ${form.alias} 将从本机配置中删除。`
                : "当前修改尚未保存，离开后将无法恢复。"}
            </p>
            <footer>
              <button
                type="button"
                className="secondary-button"
                onClick={() => setConfirmation(undefined)}
              >
                {confirmation.type === "delete" ? "取消" : "继续编辑"}
              </button>
              <button
                type="button"
                className={confirmation.type === "delete" ? "danger-button" : "primary-button"}
                onClick={() => {
                  const action = confirmation.action;
                  setConfirmation(undefined);
                  void action();
                }}
              >
                {confirmation.type === "delete" ? "确认删除" : "放弃更改"}
              </button>
            </footer>
          </section>
        </div>
      ) : null}
    </div>
  );
}

function SkillManager({ api, workspaceRoot }: { api: DesktopApi; workspaceRoot?: string }) {
  const [snapshot, setSnapshot] = useState<DesktopSkillSnapshot>();
  const [query, setQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState<"all" | DesktopSkillSnapshot["skills"][number]["source"]>("all");
  const [busy, setBusy] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [roots, setRoots] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [installType, setInstallType] = useState<SkillInstallRequest["source"]["type"]>("directory");
  const [installScope, setInstallScope] = useState<SkillInstallRequest["scope"]>(workspaceRoot ? "project" : "user");
  const [installLocation, setInstallLocation] = useState("");
  const [installRef, setInstallRef] = useState("");
  const [installSubpath, setInstallSubpath] = useState("");

  useEffect(() => {
    let active = true;
    setMessage(undefined);
    void api
      .listSkills(workspaceRoot)
      .then((next) => {
        if (!active) return;
        setSnapshot(next);
        setRoots(next.customRoots.join("\n"));
      })
      .catch(() => active && setMessage("技能列表加载失败。"));
    return () => {
      active = false;
    };
  }, [api, workspaceRoot]);

  const run = async (key: string, action: () => Promise<DesktopSkillSnapshot>) => {
    setBusy(key);
    setMessage(undefined);
    try {
      const next = await action();
      setSnapshot(next);
      setRoots(next.customRoots.join("\n"));
    } catch (error) {
      setMessage(readSkillActionError(error));
    } finally {
      setBusy(undefined);
    }
  };

  const visible = (snapshot?.skills ?? []).filter((skill) => {
    const normalized = query.trim().toLocaleLowerCase();
    return (sourceFilter === "all" || skill.source === sourceFilter)
      && (!normalized || `${skill.name} ${skill.description} ${skill.provider}`.toLocaleLowerCase().includes(normalized));
  });

  const install = () => {
    const location = installLocation.trim();
    if (!location) {
      setMessage("请填写技能来源。");
      return;
    }
    const source = installType === "git"
      ? { type: installType, location, ref: installRef.trim() || undefined, subpath: installSubpath.trim() || undefined }
      : { type: installType, location, subpath: installSubpath.trim() || undefined };
    void run("install", () => retryLifecycleConflict(
      "安装会覆盖现有技能、变更来源或降级版本。确认继续？",
      (confirmations) => api.installSkill({ workspaceRoot, scope: installScope, source, confirmations }),
    )).then(() => setShowAdd(false));
  };

  return (
    <section className="settings-group skills-settings-group">
      <div className="skill-page-actions">
        <label className="skill-search">
          <Search aria-hidden="true" />
          <input
            aria-label="搜索技能"
            placeholder="搜索技能"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <select className="skill-source-filter sr-only" aria-label="按来源筛选" value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value as typeof sourceFilter)}>
          <option value="all">全部来源</option>
          <option value="built_in">内置</option>
          <option value="system">系统</option>
          <option value="user">个人</option>
          <option value="project">项目</option>
          <option value="plugin">插件</option>
        </select>
        <button
          type="button"
          className="skill-action-button skill-icon-action"
          aria-label="重新扫描技能"
          data-tooltip="重新扫描技能"
          disabled={Boolean(busy)}
          onClick={() => void run("rescan", () => api.rescanSkills(workspaceRoot))}
        >
          <RefreshCw aria-hidden="true" />
        </button>
        <button
          type="button"
          className="skill-action-button"
          disabled={Boolean(busy)}
          onClick={() => setShowAdd((current) => !current)}
        >
          <Plus aria-hidden="true" />
          添加
        </button>
      </div>

      {showAdd ? (
        <div className="skill-add-panel">
          <p>从本地目录、ZIP 文件或 Git 仓库安装托管技能。</p>
          <div className="skill-add-fields">
            <select aria-label="安装范围" value={installScope} onChange={(event) => setInstallScope(event.target.value as SkillInstallRequest["scope"])}>
              <option value="user">个人</option>
              <option value="project" disabled={!workspaceRoot}>当前项目</option>
            </select>
            <select aria-label="来源类型" value={installType} onChange={(event) => setInstallType(event.target.value as SkillInstallRequest["source"]["type"])}>
              <option value="directory">目录</option>
              <option value="zip">ZIP</option>
              <option value="git">Git</option>
            </select>
            <input aria-label="技能来源" placeholder="目录、ZIP 或 Git 地址" value={installLocation} onChange={(event) => setInstallLocation(event.target.value)} />
            {installType === "git" ? <input aria-label="Git ref" placeholder="分支、标签或提交（可选）" value={installRef} onChange={(event) => setInstallRef(event.target.value)} /> : null}
            <input aria-label="仓库子目录" placeholder="子目录（可选）" value={installSubpath} onChange={(event) => setInstallSubpath(event.target.value)} />
            <button type="button" className="primary-button" disabled={Boolean(busy)} onClick={install}>安装</button>
          </div>
        </div>
      ) : null}

      {message ? <p className="skill-message" role="alert">{message}</p> : null}
      <div className="skill-list" aria-busy={busy === "rescan"}>
        {visible.map((skill) => (
          <article className="skill-list-item" key={skill.skillId}>
            <span className="skill-icon"><Puzzle aria-hidden="true" /></span>
            <div className="skill-summary">
              <div className="skill-title-line">
                <strong>{skill.name}</strong>
                <span>{sourceLabel(skill.source)}</span>
                <span>{skill.version ? `v${skill.version}` : "未声明版本"}</span>
                {!skill.valid ? <em>无效</em> : skill.resolution !== "resolved" ? <em>已覆盖</em> : null}
              </div>
              <p>{skill.description}</p>
              {skill.capabilities.length ? (
                <div className="skill-capabilities">
                  {skill.capabilities.map((capability) => (
                    <span key={capability}>{capabilityLabel(capability)}</span>
                  ))}
                </div>
              ) : null}
              {skill.source === "plugin" && skill.pluginDisplayName ? (
                <small>
                  来自插件 {skill.pluginDisplayName}
                  {skill.pluginVersion ? ` · v${skill.pluginVersion}` : ""}
                </small>
              ) : null}
              {skill.diagnostics[0] ? <small>{skill.diagnostics[0]}</small> : null}
              <details className="skill-details">
                <summary><span>详情</span><ChevronDown aria-hidden="true" /></summary>
                <dl>
                  <div><dt>路径</dt><dd>{skill.path}</dd></div>
                  <div><dt>约定来源</dt><dd>{skill.provider}</dd></div>
                  <div><dt>调用策略</dt><dd>{skill.allowImplicitInvocation ? "允许隐式调用，也可用 / 或 $ 显式调用" : "仅允许用 / 或 $ 显式调用"}</dd></div>
                  {skill.pluginManagementAction ? <div><dt>插件管理</dt><dd>{skill.pluginManagementAction}</dd></div> : null}
                  <div><dt>诊断</dt><dd>{skill.diagnostics.length ? skill.diagnostics.join("；") : "无"}</dd></div>
                </dl>
              </details>
              {skill.managed ? (
                <div className="skill-inline-actions">
                  {skill.canUpdate ? <button type="button" disabled={Boolean(busy)} onClick={() => void run(skill.skillId, () => retryLifecycleConflict("更新会覆盖本地修改、变更来源或降级版本。确认继续？", (confirmations) => api.updateSkill({ workspaceRoot, skillId: skill.skillId, confirmations })))}>更新</button> : null}
                  {skill.canRollback ? <button type="button" disabled={Boolean(busy)} onClick={() => void run(skill.skillId, () => api.rollbackSkill({ workspaceRoot, skillId: skill.skillId }))}><RotateCcw aria-hidden="true" />恢复上一版</button> : null}
                  {skill.canUninstall ? <button type="button" className="danger-link" disabled={Boolean(busy)} onClick={() => {
                    if (window.confirm(`卸载 ${skill.name}？`)) void run(skill.skillId, () => api.uninstallSkill({ workspaceRoot, skillId: skill.skillId }));
                  }}>卸载</button> : null}
                </div>
              ) : null}
            </div>
            <label className="skill-switch" data-tooltip={skill.source === "project" ? "仅在当前项目生效" : "在所有项目生效"}>
              <span className="sr-only">{skill.enabled ? `禁用 ${skill.name}` : `启用 ${skill.name}`}</span>
              <input
                type="checkbox"
                checked={skill.enabled}
                disabled={Boolean(busy)}
                onChange={(event) => void run(skill.skillId, () => api.setSkillEnabled({ workspaceRoot, skillId: skill.skillId, enabled: event.target.checked }))}
              />
              <i aria-hidden="true" />
            </label>
          </article>
        ))}
        {snapshot && visible.length === 0 ? <p className="skill-empty">没有找到匹配的技能。</p> : null}
        {!snapshot && !message ? <p className="skill-empty">正在扫描技能…</p> : null}
      </div>

      <details className="skill-roots">
        <summary><span>其他扫描目录</span><ChevronDown aria-hidden="true" /></summary>
        <p>兼容目录会自动扫描；这里只需要填写额外目录，每行一个。</p>
        <textarea aria-label="其他技能目录" rows={3} value={roots} onChange={(event) => setRoots(event.target.value)} />
        <button type="button" className="secondary-button" disabled={Boolean(busy)} onClick={() => void run("roots", () => api.setSkillRoots({ workspaceRoot, roots: roots.split(/\r?\n/).map((root) => root.trim()).filter(Boolean) }))}>保存目录</button>
      </details>
    </section>
  );
}

function sourceLabel(source: DesktopSkillSnapshot["skills"][number]["source"]): string {
  return ({ built_in: "内置", system: "系统", user: "个人", project: "项目", plugin: "插件" } as const)[source];
}

function capabilityLabel(capability: DesktopSkillSnapshot["skills"][number]["capabilities"][number]): string {
  return ({
    "filesystem.read": "读取文件",
    "filesystem.write": "修改文件",
    "process.execute": "运行命令",
    "network.access": "访问网络",
    "mcp.use": "使用 MCP",
  } as const)[capability];
}

const allLifecycleConfirmations = {
  overwrite: true,
  downgrade: true,
  sourceChange: true,
  localChanges: true,
  sameVersionContentChange: true,
} as const;

async function retryLifecycleConflict<T>(
  confirmationMessage: string,
  action: (confirmations?: typeof allLifecycleConfirmations) => Promise<T>,
): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (readErrorCode(error) !== "install_conflict" || !window.confirm(confirmationMessage)) throw error;
    return action(allLifecycleConfirmations);
  }
}

function readErrorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function readSkillActionError(error: unknown): string {
  return error && typeof error === "object" && "message" in error && typeof error.message === "string"
    ? error.message
    : "技能操作失败。请重试。";
}

function GeneralSettings({
  api,
  bootstrap,
  onSaved,
}: {
  api: DesktopApi;
  bootstrap: DesktopBootstrap;
  onSaved?: (bootstrap: DesktopBootstrap) => void;
}) {
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string>();
  const credential = bootstrap.webSearch;

  const save = async (clear = false) => {
    setSaving(true);
    setMessage(undefined);
    try {
      const updated = await api.updateWebSearchCredential(
        clear
          ? { mode: "clear" }
          : apiKey.trim()
            ? { mode: "inline", apiKey: apiKey.trim() }
            : { mode: "preserve" },
      );
      setApiKey("");
      setMessage(clear ? "已清除本地 Exa API Key。" : "Exa API Key 已保存。");
      onSaved?.(updated);
    } catch {
      setMessage("Exa API Key 保存失败，请重试。");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="settings-group general-settings-group">
      <h2>网页搜索 API</h2>
      <div className="settings-card profile-editor">
        <label>
          Exa API Key
          <input
            aria-label="Exa API Key"
            type="password"
            autoComplete="new-password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={
              credential?.credentialAvailable ? "已配置；留空以保留" : "输入 Exa API Key"
            }
          />
        </label>
        <p className="storage-warning">
          <AlertTriangle aria-hidden="true" />
          本地保存会以明文写入 DreamCode 配置文件；也可设置环境变量 EXA_API_KEY。
        </p>
        {credential?.credentialAvailable ? (
          <p className="configured-state">
            当前使用{credential.credentialSource === "environment" ? "环境变量" : "本地保存"}
            的凭证
          </p>
        ) : null}
        {message ? <p className="connection-result">{message}</p> : null}
        <footer className="profile-actions">
          <button
            type="button"
            className="profile-text-action danger"
            disabled={saving || credential?.credentialSource !== "inline"}
            onClick={() => void save(true)}
          >
            清除本地 Key
          </button>
          <button
            type="button"
            className="profile-text-action save"
            disabled={saving || (!apiKey.trim() && !credential?.credentialAvailable)}
            onClick={() => void save()}
          >
            <Save aria-hidden="true" />
            {saving ? "正在保存" : "保存"}
          </button>
        </footer>
      </div>
      <h2>权限</h2>
      <div className="settings-card">
        <div className="settings-row">
          <div>
            <strong>默认运行权限</strong>
            <span>每次新对话默认使用引导模式，可在消息编辑器中切换。</span>
          </div>
          <span className="settings-value">引导模式</span>
        </div>
        <div className="settings-row">
          <div>
            <strong>本地数据</strong>
            <span>项目元数据、对话记录与运行证据保存在本机。</span>
          </div>
          <span className="settings-value">仅本机</span>
        </div>
      </div>
    </section>
  );
}

function formForProfile(
  bootstrap: DesktopBootstrap,
  profile: DesktopBootstrap["profiles"][number] | undefined,
): ProfileForm {
  const provider = profile?.provider ?? bootstrap.presets[0]?.id ?? "";
  const preset = bootstrap.presets.find((item) => item.id === provider);
  const model = profile?.model ?? preset?.defaultModel ?? "";
  const presetModel = preset?.models?.some((item) => item.id === model);
  return {
    alias: profile?.alias ?? "",
    provider,
    modelChoice: presetModel ? model : customModelValue,
    customModel: presetModel ? "" : model,
    baseURL: profile?.baseURL ?? preset?.defaultBaseURL ?? "",
    credentialMode:
      profile?.credentialSource === "environment"
        ? "environment"
        : profile?.credentialSource === "inline"
          ? "inline"
          : "none",
    apiKey: "",
    apiKeyEnv: profile?.apiKeyEnv ?? "",
  };
}

function credentialAction(
  form: ProfileForm,
  existing: DesktopBootstrap["profiles"][number] | undefined,
): CredentialAction {
  if (form.credentialMode === "none") return { mode: "clear" };
  if (form.credentialMode === "environment") {
    return { mode: "environment", apiKeyEnv: form.apiKeyEnv.trim() };
  }
  if (!form.apiKey.trim() && existing?.credentialSource === "inline") {
    return { mode: "preserve" };
  }
  return { mode: "inline", apiKey: form.apiKey.trim() };
}

function validateForm(
  bootstrap: DesktopBootstrap,
  form: ProfileForm,
  selectedId: string | undefined,
  model: string,
): string | undefined {
  const alias = form.alias.trim();
  if (!alias || !form.provider || !model) return "请填写配置别名、提供商和模型。";
  const duplicate = bootstrap.profiles.some(
    (profile) =>
      profile.id !== selectedId &&
      profile.provider === form.provider &&
      profile.alias.toLocaleLowerCase() === alias.toLocaleLowerCase(),
  );
  if (duplicate) return "同一厂商下已存在相同配置别名。";
  const preset = bootstrap.presets.find((item) => item.id === form.provider);
  if (preset?.requiresBaseURL && !form.baseURL.trim()) return "自定义服务必须填写 Base URL。";
  if (form.baseURL.trim() && !/^https?:\/\//i.test(form.baseURL.trim())) {
    return "Base URL 必须使用 HTTP 或 HTTPS。";
  }
  if (
    form.credentialMode === "environment" &&
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(form.apiKeyEnv.trim())
  ) {
    return "请输入有效的环境变量名称。";
  }
  const existing = bootstrap.profiles.find((profile) => profile.id === selectedId);
  if (
    form.credentialMode === "inline" &&
    !form.apiKey.trim() &&
    existing?.credentialSource !== "inline"
  ) {
    return "请输入 API Key。";
  }
  return undefined;
}

function providerName(bootstrap: DesktopBootstrap, provider: string): string {
  if (provider === "openai-compatible") return "自定义服务";
  return bootstrap.presets.find((item) => item.id === provider)?.displayName ?? provider;
}

function optional(value: string): string | undefined {
  return value.trim() || undefined;
}
