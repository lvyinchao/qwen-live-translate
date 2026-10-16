import type { UILanguage } from '../../../lib/types';
import { translator } from '../ui';
export function ProviderNotice({ locale }: { locale: UILanguage }) {
  const t = translator(locale);
  return <p className="provider-notice">
    {t('翻译需要你自己的账号和 API Key。请前往')}{' '}
    <a href="https://qianwenai.com/" target="_blank" rel="noopener noreferrer">qianwenai.com</a>{' '}
    {t('注册账号并申请 API Key，模型费用由你的账号按用量结算。')}
  </p>;
}
