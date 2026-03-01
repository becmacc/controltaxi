
import React, { useState, useEffect } from 'react';
import { useStore } from '../context/StoreContext';
import { Button } from '../components/ui/Button';
import { Save, Coins, Clock, Activity, MessageSquare, Info, Phone, Fuel } from 'lucide-react';
import { MessageTemplates } from '../types';
import { DEFAULT_TEMPLATES, DEFAULT_OWNER_DRIVER_COMPANY_SHARE_PERCENT, DEFAULT_COMPANY_CAR_DRIVER_GAS_COMPANY_SHARE_PERCENT, DEFAULT_OTHER_DRIVER_COMPANY_SHARE_PERCENT } from '../constants';
import {
  applyPhoneDialCode,
  DEFAULT_PHONE_DIAL_CODE,
  detectPhoneDialCode,
  normalizePhoneForWhatsApp,
  PHONE_COUNTRY_PRESETS,
} from '../services/whatsapp';

export const SettingsPage: React.FC = () => {
  const { settings, updateSettings } = useStore();
  const [exchangeRate, setExchangeRate] = useState(settings.exchangeRate.toString());
  const [hourlyWaitRate, setHourlyWaitRate] = useState(settings.hourlyWaitRate.toString());
  const [ratePerKm, setRatePerKm] = useState(settings.ratePerKm.toString());
  const [fuelPriceUsdPerLiter, setFuelPriceUsdPerLiter] = useState(settings.fuelPriceUsdPerLiter.toString());
  const [ownerDriverCompanySharePercent, setOwnerDriverCompanySharePercent] = useState(settings.ownerDriverCompanySharePercent.toString());
  const [companyCarDriverGasCompanySharePercent, setCompanyCarDriverGasCompanySharePercent] = useState(settings.companyCarDriverGasCompanySharePercent.toString());
  const [otherDriverCompanySharePercent, setOtherDriverCompanySharePercent] = useState(settings.otherDriverCompanySharePercent.toString());
  const [operatorWhatsApp, setOperatorWhatsApp] = useState(settings.operatorWhatsApp || '');
  const [operatorIntlEnabled, setOperatorIntlEnabled] = useState(false);
  const [operatorDialCode, setOperatorDialCode] = useState(DEFAULT_PHONE_DIAL_CODE);
  const [operatorUseCustomDialCode, setOperatorUseCustomDialCode] = useState(false);
  const [operatorCustomDialCode, setOperatorCustomDialCode] = useState('');
  const [templates, setTemplates] = useState<MessageTemplates>(settings.templates);
  const [message, setMessage] = useState('');

  const operatorPopularPresets = PHONE_COUNTRY_PRESETS;
  const resolvedOperatorCustomDialCode = operatorCustomDialCode.replace(/\D/g, '');
  const selectedOperatorIntlDialCode = operatorUseCustomDialCode
    ? (resolvedOperatorCustomDialCode || operatorDialCode || DEFAULT_PHONE_DIAL_CODE)
    : operatorDialCode;
  const operatorEffectiveDialCode = operatorIntlEnabled ? selectedOperatorIntlDialCode : DEFAULT_PHONE_DIAL_CODE;

  useEffect(() => {
    setExchangeRate(settings.exchangeRate.toString());
    setHourlyWaitRate(settings.hourlyWaitRate.toString());
    setRatePerKm(settings.ratePerKm.toString());
    setFuelPriceUsdPerLiter(settings.fuelPriceUsdPerLiter.toString());
    setOwnerDriverCompanySharePercent(settings.ownerDriverCompanySharePercent.toString());
    setCompanyCarDriverGasCompanySharePercent(settings.companyCarDriverGasCompanySharePercent.toString());
    setOtherDriverCompanySharePercent(settings.otherDriverCompanySharePercent.toString());
    const operatorPhone = settings.operatorWhatsApp || '';
    setOperatorWhatsApp(operatorPhone);
    const detectedDialCode = detectPhoneDialCode(operatorPhone) || DEFAULT_PHONE_DIAL_CODE;
    const isKnownPreset = operatorPopularPresets.some(option => option.dialCode === detectedDialCode);
    setOperatorIntlEnabled(detectedDialCode !== DEFAULT_PHONE_DIAL_CODE);
    if (isKnownPreset) {
      setOperatorDialCode(detectedDialCode);
      setOperatorUseCustomDialCode(false);
      setOperatorCustomDialCode('');
    } else {
      setOperatorDialCode(DEFAULT_PHONE_DIAL_CODE);
      setOperatorUseCustomDialCode(true);
      setOperatorCustomDialCode(detectedDialCode);
    }
    setTemplates(settings.templates);
  }, [settings]);

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();

    const parseOrDefault = (raw: string, fallback: number) => {
      const parsed = Number(raw);
      return Number.isFinite(parsed) ? parsed : fallback;
    };

    const normalizedOperatorWhatsApp = normalizePhoneForWhatsApp(operatorWhatsApp.trim(), {
      defaultDialCode: operatorEffectiveDialCode,
    });

    updateSettings({
      exchangeRate: parseOrDefault(exchangeRate, 90000),
      hourlyWaitRate: parseOrDefault(hourlyWaitRate, 5),
      ratePerKm: parseOrDefault(ratePerKm, 1.1),
      googleMapsApiKey: settings.googleMapsApiKey,
      googleMapsMapId: settings.googleMapsMapId,
      googleMapsMapIdDark: settings.googleMapsMapIdDark,
      operatorWhatsApp: normalizedOperatorWhatsApp || operatorWhatsApp.trim(),
      fuelPriceUsdPerLiter: parseOrDefault(fuelPriceUsdPerLiter, 1.3),
      ownerDriverCompanySharePercent: parseOrDefault(ownerDriverCompanySharePercent, DEFAULT_OWNER_DRIVER_COMPANY_SHARE_PERCENT),
      companyCarDriverGasCompanySharePercent: parseOrDefault(companyCarDriverGasCompanySharePercent, DEFAULT_COMPANY_CAR_DRIVER_GAS_COMPANY_SHARE_PERCENT),
      otherDriverCompanySharePercent: parseOrDefault(otherDriverCompanySharePercent, DEFAULT_OTHER_DRIVER_COMPANY_SHARE_PERCENT),
      templates
    });
    setMessage('Settings saved successfully.');
    setTimeout(() => setMessage(''), 3000);
  };

  const handleTemplateChange = (key: keyof MessageTemplates, value: string) => {
    setTemplates(prev => ({ ...prev, [key]: value }));
  };

  const handleResetTemplates = () => {
    setTemplates(DEFAULT_TEMPLATES);
    setMessage('Templates reset to WhatsApp-safe defaults. Click Commit Settings to save.');
    setTimeout(() => setMessage(''), 3000);
  };

  return (
    <div className="app-page-shell p-4 md:p-6 bg-slate-50 dark:bg-brand-950 transition-colors duration-300 min-h-full pb-20">
      <div className="max-w-3xl mx-auto">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-6 gap-4">
          <h2 className="text-2xl font-black text-brand-900 dark:text-slate-100 uppercase tracking-tight">System Configuration</h2>
        </div>

        <form onSubmit={handleSave} className="space-y-8">
          {/* Financial & Distance Settings */}
          <div className="bg-white dark:bg-brand-900 rounded-2xl shadow-xl border border-slate-200 dark:border-brand-800 p-6 md:p-8 transition-colors">
            <h3 className="text-sm font-black text-brand-900 dark:text-gold-500 uppercase tracking-widest mb-6 border-b pb-4 dark:border-brand-800">Operational Yield Parameters</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-6">
              <div>
                <label className="block text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-2">Exchange Rate (1 USD)</label>
                <div className="relative group">
                  <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400 group-focus-within:text-gold-600 transition-colors">
                    <Coins size={18} />
                  </div>
                  <input
                    type="number"
                    value={exchangeRate}
                    onChange={(e) => setExchangeRate(e.target.value)}
                    className="block w-full rounded-xl border-slate-200 dark:border-brand-800 shadow-sm focus:border-brand-900 dark:focus:border-gold-600 focus:ring-brand-900 dark:focus:ring-gold-600 text-lg font-black p-3 pl-11 border bg-slate-50 dark:bg-brand-950 text-slate-900 dark:text-slate-100 transition-all"
                    required
                  />
                  <div className="absolute inset-y-0 right-0 pr-4 flex items-center pointer-events-none">
                    <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">LBP</span>
                  </div>
                </div>
              </div>

              <div>
                <label className="block text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-2">Distance Rate</label>
                <div className="relative group">
                  <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400 group-focus-within:text-gold-600 transition-colors">
                    <Activity size={18} />
                  </div>
                  <input
                    type="number"
                    step="0.05"
                    value={ratePerKm}
                    onChange={(e) => setRatePerKm(e.target.value)}
                    className="block w-full rounded-xl border-slate-200 dark:border-brand-800 shadow-sm focus:border-brand-900 dark:focus:border-gold-600 focus:ring-brand-900 dark:focus:ring-gold-600 text-lg font-black p-3 pl-11 border bg-slate-50 dark:bg-brand-950 text-slate-900 dark:text-slate-100 transition-all"
                    required
                  />
                  <div className="absolute inset-y-0 right-0 pr-4 flex items-center pointer-events-none">
                    <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">$/km</span>
                  </div>
                </div>
              </div>

              <div>
                <label className="block text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-2">Hourly Wait Rate</label>
                <div className="relative group">
                  <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400 group-focus-within:text-gold-600 transition-colors">
                    <Clock size={18} />
                  </div>
                  <input
                    type="number"
                    value={hourlyWaitRate}
                    onChange={(e) => setHourlyWaitRate(e.target.value)}
                    className="block w-full rounded-xl border-slate-200 dark:border-brand-800 shadow-sm focus:border-brand-900 dark:focus:border-gold-600 focus:ring-brand-900 dark:focus:ring-gold-600 text-lg font-black p-3 pl-11 border bg-slate-50 dark:bg-brand-950 text-slate-900 dark:text-slate-100 transition-all"
                    required
                  />
                  <div className="absolute inset-y-0 right-0 pr-4 flex items-center pointer-events-none">
                    <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">USD</span>
                  </div>
                </div>
              </div>

              <div>
                <label className="block text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-2">Fuel Price</label>
                <div className="relative group">
                  <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400 group-focus-within:text-gold-600 transition-colors">
                    <Fuel size={18} />
                  </div>
                  <input
                    type="number"
                    step="0.01"
                    value={fuelPriceUsdPerLiter}
                    onChange={(e) => setFuelPriceUsdPerLiter(e.target.value)}
                    className="block w-full rounded-xl border-slate-200 dark:border-brand-800 shadow-sm focus:border-brand-900 dark:focus:border-gold-600 focus:ring-brand-900 dark:focus:ring-gold-600 text-lg font-black p-3 pl-11 border bg-slate-50 dark:bg-brand-950 text-slate-900 dark:text-slate-100 transition-all"
                    required
                  />
                  <div className="absolute inset-y-0 right-0 pr-4 flex items-center pointer-events-none">
                    <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">USD/L</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="bg-white dark:bg-brand-900 rounded-2xl shadow-xl border border-slate-200 dark:border-brand-800 p-6 md:p-8 transition-colors">
            <h3 className="text-sm font-black text-brand-900 dark:text-gold-500 uppercase tracking-widest mb-6 border-b pb-4 dark:border-brand-800">Driver Share Rules</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <div>
                <label className="block text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-2">Owner Driver → Company %</label>
                <input
                  type="number"
                  min="0"
                  max="100"
                  step="0.5"
                  value={ownerDriverCompanySharePercent}
                  onChange={(e) => setOwnerDriverCompanySharePercent(e.target.value)}
                  className="block w-full rounded-xl border-slate-200 dark:border-brand-800 shadow-sm focus:border-brand-900 dark:focus:border-gold-600 focus:ring-brand-900 dark:focus:ring-gold-600 text-lg font-black p-3 border bg-slate-50 dark:bg-brand-950 text-slate-900 dark:text-slate-100 transition-all"
                  required
                />
              </div>

              <div>
                <label className="block text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-2">Company Car + Driver Gas → Company %</label>
                <input
                  type="number"
                  min="0"
                  max="100"
                  step="0.5"
                  value={companyCarDriverGasCompanySharePercent}
                  onChange={(e) => setCompanyCarDriverGasCompanySharePercent(e.target.value)}
                  className="block w-full rounded-xl border-slate-200 dark:border-brand-800 shadow-sm focus:border-brand-900 dark:focus:border-gold-600 focus:ring-brand-900 dark:focus:ring-gold-600 text-lg font-black p-3 border bg-slate-50 dark:bg-brand-950 text-slate-900 dark:text-slate-100 transition-all"
                  required
                />
              </div>

              <div>
                <label className="block text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-2">Other Arrangements → Company %</label>
                <input
                  type="number"
                  min="0"
                  max="100"
                  step="0.5"
                  value={otherDriverCompanySharePercent}
                  onChange={(e) => setOtherDriverCompanySharePercent(e.target.value)}
                  className="block w-full rounded-xl border-slate-200 dark:border-brand-800 shadow-sm focus:border-brand-900 dark:focus:border-gold-600 focus:ring-brand-900 dark:focus:ring-gold-600 text-lg font-black p-3 border bg-slate-50 dark:bg-brand-950 text-slate-900 dark:text-slate-100 transition-all"
                  required
                />
              </div>
            </div>
            <p className="mt-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Used in CRM finance calculations to compute company owed share per driver.</p>
          </div>

          {/* Messaging Templates */}
          <div className="bg-white dark:bg-brand-900 rounded-2xl shadow-xl border border-slate-200 dark:border-brand-800 p-6 md:p-8 transition-colors">
            <div className="flex justify-between items-center mb-6 border-b pb-4 dark:border-brand-800">
               <h3 className="text-sm font-black text-brand-900 dark:text-gold-500 uppercase tracking-widest">Customer Engagement Templates</h3>
               <div className="flex items-center gap-2">
                 <Button type="button" variant="outline" className="h-8 text-[9px] px-3" onClick={handleResetTemplates}>
                   Reset Defaults
                 </Button>
                 <MessageSquare size={18} className="text-gold-600" />
               </div>
            </div>
            
            <div className="space-y-6">
               <div>
                <label className="block text-[9px] font-black text-slate-400 uppercase tracking-widest mb-2 px-1">Operator WhatsApp (Extract Send Target)</label>
                <div className="relative group">
                  <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-slate-400 group-focus-within:text-gold-600 transition-colors">
                    <Phone size={16} />
                  </div>
                  <input
                    type="text"
                    value={operatorWhatsApp}
                    onChange={(e) => {
                      const nextPhone = e.target.value;
                      setOperatorWhatsApp(nextPhone);
                      const detectedDialCode = detectPhoneDialCode(nextPhone);
                      if (detectedDialCode) {
                        const isKnownPreset = operatorPopularPresets.some(option => option.dialCode === detectedDialCode);
                        setOperatorIntlEnabled(detectedDialCode !== DEFAULT_PHONE_DIAL_CODE);
                        if (isKnownPreset) {
                          setOperatorUseCustomDialCode(false);
                          setOperatorDialCode(detectedDialCode);
                        } else {
                          setOperatorUseCustomDialCode(true);
                          setOperatorCustomDialCode(detectedDialCode);
                        }
                      }
                    }}
                    className="block w-full rounded-xl border-slate-200 dark:border-brand-800 shadow-sm focus:border-brand-900 dark:focus:border-gold-600 focus:ring-brand-900 dark:focus:ring-gold-600 text-sm h-11 border bg-slate-50 dark:bg-brand-950 text-slate-900 dark:text-slate-100 transition-all pl-11 pr-3"
                    placeholder="e.g. +96170123456"
                  />
                </div>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setOperatorIntlEnabled(prev => !prev)}
                    className={`h-8 rounded-lg border text-[8px] font-black uppercase tracking-widest transition-colors ${operatorIntlEnabled ? 'border-blue-300 text-blue-700 bg-blue-50 dark:border-blue-900/40 dark:text-blue-300 dark:bg-blue-900/10' : 'border-emerald-300 text-emerald-700 bg-emerald-50 dark:border-emerald-900/40 dark:text-emerald-300 dark:bg-emerald-900/10'}`}
                  >
                    {operatorIntlEnabled ? 'INTL ON' : 'INTL OFF (LB)'}
                  </button>
                  {operatorIntlEnabled ? (
                    <select
                      value={operatorUseCustomDialCode ? 'OTHER' : operatorDialCode}
                      onChange={event => {
                        const value = event.target.value;
                        if (value === 'OTHER') {
                          setOperatorUseCustomDialCode(true);
                          return;
                        }

                        setOperatorUseCustomDialCode(false);
                        setOperatorDialCode(value);
                        setOperatorWhatsApp(prev => applyPhoneDialCode(prev, value));
                      }}
                      className="h-8 rounded-lg border border-slate-200 dark:border-white/10 bg-white dark:bg-brand-950 px-2 text-[8px] font-black uppercase tracking-widest text-slate-600 dark:text-slate-300"
                      aria-label="Select operator country code"
                    >
                      {operatorPopularPresets.map(option => (
                        <option key={option.key} value={option.dialCode}>{option.label}</option>
                      ))}
                      <option value="OTHER">Other code...</option>
                    </select>
                  ) : (
                    <div className="h-8 rounded-lg border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-brand-950 px-2 flex items-center text-[8px] font-black uppercase tracking-widest text-slate-500 dark:text-slate-300">
                      Default +961
                    </div>
                  )}
                </div>
                {operatorIntlEnabled && operatorUseCustomDialCode && (
                  <input
                    type="text"
                    value={operatorCustomDialCode}
                    onChange={event => {
                      const digits = event.target.value.replace(/\D/g, '').slice(0, 4);
                      setOperatorCustomDialCode(digits);
                      if (digits.length > 0) {
                        setOperatorWhatsApp(prev => applyPhoneDialCode(prev, digits));
                      }
                    }}
                    className="mt-2 block w-full rounded-xl border-slate-200 dark:border-brand-800 shadow-sm focus:border-brand-900 dark:focus:border-gold-600 focus:ring-brand-900 dark:focus:ring-gold-600 text-sm h-11 border bg-slate-50 dark:bg-brand-950 text-slate-900 dark:text-slate-100 transition-all px-3"
                    placeholder="Other country code (e.g. 1, 61)"
                    aria-label="Custom operator country code"
                  />
                )}
                <p className="mt-2 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Used by Trips extract quick-send action.</p>
               </div>

               <div className="bg-brand-50 dark:bg-brand-950 p-4 rounded-xl border border-brand-100 dark:border-brand-800 mb-4">
                  <div className="flex items-start">
                     <Info size={14} className="text-brand-600 mr-2 mt-0.5" />
                    <p className="text-[10px] font-bold text-brand-800 dark:text-slate-400 uppercase leading-relaxed">
                      Supported Placeholders: <span className="text-gold-600">{"{customer_name}"}</span>, <span className="text-gold-600">{"{pickup}"}</span>, <span className="text-gold-600">{"{destination}"}</span>, <span className="text-gold-600">{"{trip_datetime_formatted}"}</span>, <span className="text-gold-600">{"{fare_usd}"}</span>, <span className="text-gold-600">{"{fare_lbp}"}</span>, <span className="text-gold-600">{"{driver_name}"}</span>, <span className="text-gold-600">{"{driver_name_with_plate}"}</span>
                    </p>
                  </div>
               </div>

               <div className="space-y-4">
                  <div>
                    <label className="block text-[9px] font-black text-slate-400 uppercase tracking-widest mb-2 px-1">Trip Confirmation (Post-Save)</label>
                    <textarea 
                      value={templates.trip_confirmation}
                      onChange={(e) => handleTemplateChange('trip_confirmation', e.target.value)}
                      className="w-full h-32 rounded-xl border border-slate-200 dark:border-brand-800 p-4 bg-slate-50 dark:bg-brand-950 text-sm font-medium focus:ring-2 focus:ring-gold-500 outline-none transition-all resize-none"
                    />
                  </div>
                  <div>
                    <label className="block text-[9px] font-black text-slate-400 uppercase tracking-widest mb-2 px-1">Feedback Request (Post-Completion)</label>
                    <textarea 
                      value={templates.feedback_request}
                      onChange={(e) => handleTemplateChange('feedback_request', e.target.value)}
                      className="w-full h-32 rounded-xl border border-slate-200 dark:border-brand-800 p-4 bg-slate-50 dark:bg-brand-950 text-sm font-medium focus:ring-2 focus:ring-gold-500 outline-none transition-all resize-none"
                    />
                  </div>
                  <div>
                    <label className="block text-[9px] font-black text-slate-400 uppercase tracking-widest mb-2 px-1">Thank You (Post-Feedback)</label>
                    <textarea 
                      value={templates.feedback_thanks}
                      onChange={(e) => handleTemplateChange('feedback_thanks', e.target.value)}
                      className="w-full h-32 rounded-xl border border-slate-200 dark:border-brand-800 p-4 bg-slate-50 dark:bg-brand-950 text-sm font-medium focus:ring-2 focus:ring-gold-500 outline-none transition-all resize-none"
                    />
                  </div>
               </div>
            </div>
          </div>

          <div className="pt-6 flex flex-col sm:flex-row items-center justify-between gap-4">
            <span className="text-green-600 dark:text-green-400 font-black text-[10px] uppercase tracking-widest transition-all">{message}</span>
            <Button type="submit" variant="gold" size="lg" className="w-full sm:w-auto min-w-[200px] shadow-xl shadow-gold-500/20">
              <Save size={18} className="mr-2" />
              Commit Settings
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
};
