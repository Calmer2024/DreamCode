import { AlertTriangle, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { DesktopApi, DesktopBootstrap, SaveProfileRequest } from "../../shared/contracts";

interface ConfigDialogProps {
  api: DesktopApi;
  bootstrap: DesktopBootstrap;
  open: boolean;
  onClose: () => void;
  onSaved?: (bootstrap: DesktopBootstrap) => void;
}

const customModelValue = "__custom__";

export function ConfigDialog({ api, bootstrap, open, onClose, onSaved }: ConfigDialogProps) {
  const initialProfile =
    bootstrap.profiles.find((profile) => profile.name === bootstrap.currentProfile) ??
    bootstrap.profiles[0];
  const [profileName, setProfileName] = useState(initialProfile?.name ?? "");
  const selectedProfile =
    bootstrap.profiles.find((profile) => profile.name === profileName) ?? initialProfile;
  const [provider, setProvider] = useState(
    selectedProfile?.provider ?? bootstrap.presets[0]?.id ?? "",
  );
  const preset = bootstrap.presets.find((item) => item.id === provider);
  const presetModels = useMemo(() => preset?.models ?? [], [preset]);
  const initialModel = selectedProfile?.model ?? preset?.defaultModel ?? "";
  const [modelChoice, setModelChoice] = useState(
    presetModels.some((model) => model.id === initialModel) ? initialModel : customModelValue,
  );
  const [customModel, setCustomModel] = useState(
    presetModels.some((model) => model.id === initialModel) ? "" : initialModel,
  );
  const [baseURL, setBaseURL] = useState(selectedProfile?.baseURL ?? "");
  const [apiKey, setApiKey] = useState("");
  const [apiKeyEnv, setApiKeyEnv] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const nextProfile = bootstrap.profiles.find((profile) => profile.name === profileName);
    if (!nextProfile) return;
    setProvider(nextProfile.provider);
    setBaseURL(nextProfile.baseURL ?? "");
    setApiKey("");
    setApiKeyEnv("");
    const nextPreset = bootstrap.presets.find((item) => item.id === nextProfile.provider);
    if (nextPreset?.models?.some((model) => model.id === nextProfile.model)) {
      setModelChoice(nextProfile.model ?? nextPreset.defaultModel);
      setCustomModel("");
    } else {
      setModelChoice(customModelValue);
      setCustomModel(nextProfile.model ?? nextPreset?.defaultModel ?? "");
    }
  }, [bootstrap, profileName]);

  if (!open) return null;

  const save = async () => {
    const name = profileName.trim();
    const model = (modelChoice === customModelValue ? customModel : modelChoice).trim();
    if (!name || !provider || !model) {
      setError("请填写配置名称、提供商和模型。");
      return;
    }
    const request: SaveProfileRequest = {
      name,
      provider,
      model,
      baseURL: optional(baseURL),
      apiKey: optional(apiKey),
      apiKeyEnv: optional(apiKeyEnv),
    };
    setSaving(true);
    setError(undefined);
    try {
      const updated = await api.saveProfile(request);
      onSaved?.(updated);
      onClose();
    } catch {
      setError("配置保存失败，请重试。");
    } finally {
      setSaving(false);
    }
  };

  const selectProvider = (nextProvider: string) => {
    const nextPreset = bootstrap.presets.find((item) => item.id === nextProvider);
    setProvider(nextProvider);
    setModelChoice(nextPreset?.models?.[0]?.id ?? customModelValue);
    setCustomModel(nextPreset?.models?.length ? "" : (nextPreset?.defaultModel ?? ""));
  };

  return (
    <div className="modal-backdrop">
      <section
        className="dialog-card config-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="模型与配置"
      >
        <header className="dialog-header">
          <div>
            <p className="dialog-kicker">模型设置</p>
            <h2>模型与配置</h2>
          </div>
          <button type="button" className="icon-button" aria-label="关闭配置" onClick={onClose}>
            <X aria-hidden="true" />
          </button>
        </header>

        <div className="dialog-form">
          <label>
            配置名称
            <input
              aria-label="配置名称"
              value={profileName}
              onChange={(event) => setProfileName(event.target.value)}
              list="profile-names"
            />
          </label>
          <datalist id="profile-names">
            {bootstrap.profiles.map((profile) => (
              <option value={profile.name} key={profile.name} />
            ))}
          </datalist>
          <label>
            提供商
            <select
              aria-label="提供商"
              value={provider}
              onChange={(event) => selectProvider(event.target.value)}
            >
              {bootstrap.presets.map((item) => (
                <option value={item.id} key={item.id}>
                  {item.displayName}
                </option>
              ))}
            </select>
          </label>
          <label>
            模型
            <select
              aria-label="模型"
              value={modelChoice}
              onChange={(event) => setModelChoice(event.target.value)}
            >
              {presetModels.map((model) => (
                <option value={model.id} key={model.id}>
                  {model.label ?? model.id}
                </option>
              ))}
              <option value={customModelValue}>自定义模型</option>
            </select>
          </label>
          {modelChoice === customModelValue ? (
            <label>
              自定义模型 ID
              <input
                aria-label="自定义模型 ID"
                value={customModel}
                onChange={(event) => setCustomModel(event.target.value)}
              />
            </label>
          ) : null}
          <label>
            Base URL
            <input
              aria-label="Base URL"
              value={baseURL}
              onChange={(event) => setBaseURL(event.target.value)}
              placeholder="https://api.example.com/v1"
            />
          </label>
          <label>
            新的 API Key
            <input
              aria-label="新的 API Key"
              type="password"
              autoComplete="new-password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={
                selectedProfile?.apiKeyConfigured ? "输入新的 Key 以替换" : "输入 API Key"
              }
            />
          </label>
          {selectedProfile?.apiKeyConfigured ? (
            <p className="configured-state">API Key 已配置</p>
          ) : null}
          <label>
            API Key 环境变量
            <input
              aria-label="API Key 环境变量"
              value={apiKeyEnv}
              onChange={(event) => setApiKeyEnv(event.target.value)}
              placeholder="OPENAI_API_KEY"
            />
          </label>
          <p className="storage-warning">
            <AlertTriangle aria-hidden="true" />
            API Key 将以明文存储在本机 DreamCode 配置文件中。建议优先使用环境变量。
          </p>
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
        </div>

        <footer className="dialog-actions">
          <button type="button" className="secondary-button" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={saving}
            onClick={() => void save()}
          >
            {saving ? "正在保存" : "保存配置"}
          </button>
        </footer>
      </section>
    </div>
  );
}

function optional(value: string): string | undefined {
  return value.trim() || undefined;
}
