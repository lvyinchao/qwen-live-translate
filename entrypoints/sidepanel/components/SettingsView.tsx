import { AudioLines, Check, ChevronLeft, KeyRound, LoaderCircle } from 'lucide-react';
import type { UILanguage } from '../../../lib/types';
import type { PublicSettings } from '../api';
import { translator } from '../ui';
import { ProviderNotice } from './ProviderNotice';
import { StorageView } from './StorageView';

export interface SettingsViewProps {
  locale: UILanguage;
  settings: PublicSettings;
  apiKey: string;
  busy: string;
  activeSession: boolean;
  saving: boolean;
  onBack: () => void;
  onApiKey: (value: string) => void;
  onSettings: (settings: PublicSettings) => void;
  onSave: () => void;
  onTest: () => void;
  onForget: () => void;
  onDiagnostics: () => void;
  onAction: (name: string, operation: () => Promise<void>) => Promise<void>;
  onNotice: (message: string) => void;
}
export function SettingsView(props: SettingsViewProps) {
  const { locale, settings, apiKey, busy } = props;
  const t = translator(locale);
  return <>
    <button className="back" onClick={props.onBack}><ChevronLeft size={16} />{t('返回视频')}</button>
    <div className="section-heading"><h1>{t('连接你的百炼')}</h1><KeyRound size={20} /></div>
    <p className="description">{t('使用自己的账户调用模型。凭据只保存在本机，不会提供给视频网页。')}</p>
    <ProviderNotice locale={locale} />
    <section className="settings-form">
      <label htmlFor="api-key">API Key <span>{settings.hasKey ? t('已保存') : t('待填写')}</span></label>
      <input id="api-key" type="password" autoComplete="off" disabled={props.activeSession || !!busy}
        placeholder={settings.hasKey ? t('留空保留已保存的 Key') : 'sk-…'} value={apiKey}
        onChange={(event) => props.onApiKey(event.target.value)} />
      <label htmlFor="workspace">Workspace ID</label>
      <input id="workspace" autoComplete="off" disabled={props.activeSession || !!busy} placeholder={t('百炼业务空间 ID')}
        value={settings.workspace} onChange={(event) => props.onSettings({ ...settings, workspace: event.target.value })} />
      <label htmlFor="region">{t('服务地域')}</label>
      <select id="region" value={settings.region} disabled={props.activeSession || !!busy}
        onChange={(event) => props.onSettings({ ...settings, region: event.target.value as PublicSettings['region'] })}>
        <option value="cn-beijing">{t('华北 2 · 北京')}</option>
        <option value="ap-southeast-1">{t('新加坡')}</option>
      </select>
      <button className="primary" disabled={!!busy || props.activeSession || !settings.workspace || (!apiKey && !settings.hasKey)} onClick={props.onSave}>
        {busy === 'save' ? <LoaderCircle className="spin" size={17} /> : <Check size={17} />}{t('保存配置')}
      </button>
      <button className="secondary" disabled={!!busy || props.activeSession || (!apiKey && !settings.hasKey)} onClick={props.onTest}>
        {busy === 'test' ? <LoaderCircle className="spin" size={16} /> : <AudioLines size={16} />}{t('验证连接')}
      </button>
      {props.activeSession && <small className="settings-hint">{t('请先停止翻译，再修改服务凭据')}</small>}
    </section>
    <div className="model-note">
      <span className="eyebrow">{t('当前模型')}</span><strong>Qwen3.8 LiveTranslate</strong>
      <p>{t('支持 29 种语言译音，随原说话人复刻音色。费用由百炼账户按实际用量结算。')}</p>
    </div>
    <button className="text-button" disabled={!!busy} onClick={props.onDiagnostics}>{t('导出最近一次播放诊断')}</button>
    <StorageView locale={locale} busy={busy} activeSession={props.activeSession} saving={props.saving}
      onAction={props.onAction} onNotice={props.onNotice} />
    <div className="settings-actions">
      <button disabled={!!busy} onClick={props.onForget}>{t('移除凭据')}</button>
    </div>
  </>;
}
