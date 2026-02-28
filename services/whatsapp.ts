export interface PhoneCountryPreset {
  key: 'LB' | 'AE' | 'SA' | 'QA' | 'KW' | 'BH' | 'FR' | 'TR' | 'US' | 'AU' | 'UK';
  label: string;
  dialCode: string;
}

export const DEFAULT_PHONE_DIAL_CODE = '961';

export const PHONE_COUNTRY_PRESETS: PhoneCountryPreset[] = [
  { key: 'LB', label: 'LB +961', dialCode: '961' },
  { key: 'US', label: 'US +1', dialCode: '1' },
  { key: 'AU', label: 'AU +61', dialCode: '61' },
  { key: 'UK', label: 'UK +44', dialCode: '44' },
  { key: 'AE', label: 'UAE +971', dialCode: '971' },
  { key: 'SA', label: 'KSA +966', dialCode: '966' },
  { key: 'QA', label: 'QAT +974', dialCode: '974' },
  { key: 'KW', label: 'KWT +965', dialCode: '965' },
  { key: 'BH', label: 'BHR +973', dialCode: '973' },
  { key: 'FR', label: 'FR +33', dialCode: '33' },
  { key: 'TR', label: 'TR +90', dialCode: '90' },
];

const KNOWN_DIAL_CODES = PHONE_COUNTRY_PRESETS
  .map(option => option.dialCode)
  .sort((a, b) => b.length - a.length);

const stripInternationalPrefix = (value: string): string => {
  return value.startsWith('00') ? value.slice(2) : value;
};

export const detectPhoneDialCode = (rawPhone: string): string | null => {
  const digitsOnly = stripInternationalPrefix((rawPhone || '').replace(/\D/g, ''));
  if (!digitsOnly) return null;
  const match = KNOWN_DIAL_CODES.find(code => digitsOnly.startsWith(code));
  return match || null;
};

export const applyPhoneDialCode = (rawPhone: string, dialCode: string): string => {
  const safeDialCode = (dialCode || '').replace(/\D/g, '') || DEFAULT_PHONE_DIAL_CODE;
  let digitsOnly = stripInternationalPrefix((rawPhone || '').replace(/\D/g, ''));

  const detectedCode = detectPhoneDialCode(digitsOnly);
  if (detectedCode) {
    digitsOnly = digitsOnly.slice(detectedCode.length);
  }

  if (digitsOnly.startsWith('0')) {
    digitsOnly = digitsOnly.slice(1);
  }

  return `${safeDialCode}${digitsOnly}`;
};

export const normalizePhoneForWhatsApp = (
  rawPhone: string,
  options?: { defaultDialCode?: string }
): string | null => {
  const digitsOnly = (rawPhone || '').replace(/\D/g, '');
  if (!digitsOnly) return null;

  let normalized = stripInternationalPrefix(digitsOnly);
  const preferredDialCode = (options?.defaultDialCode || DEFAULT_PHONE_DIAL_CODE).replace(/\D/g, '') || DEFAULT_PHONE_DIAL_CODE;

  if (normalized.startsWith('961')) {
    return normalized.length >= 10 && normalized.length <= 11 ? normalized : null;
  }

  const knownIntlCode = KNOWN_DIAL_CODES.find(code => normalized.startsWith(code));
  if (knownIntlCode) {
    return normalized.length >= 10 && normalized.length <= 15 ? normalized : null;
  }

  if (normalized.startsWith('0')) {
    normalized = normalized.slice(1);
  }

  if (normalized.length >= 7 && normalized.length <= 8) {
    return `${preferredDialCode}${normalized}`;
  }

  if (normalized.length >= 10 && normalized.length <= 15) {
    return normalized;
  }

  return null;
};

export const buildWhatsAppLink = (phone: string, message?: string): string | null => {
  const normalized = normalizePhoneForWhatsApp(phone);
  if (!normalized) return null;

  const base = `https://wa.me/${normalized}`;
  if (!message) return base;

  return `${base}?text=${encodeURIComponent(message)}`;
};
