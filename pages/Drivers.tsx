
import React, { useState, useMemo, useEffect } from 'react';
import { useStore } from '../context/StoreContext';
import { Driver, TripStatus, DriverAvailability } from '../types';
import { isToday, parseISO, subDays } from 'date-fns';
import { Button } from '../components/ui/Button';
import { HorizontalScrollArea } from '../components/ui/HorizontalScrollArea';
import {
  applyPhoneDialCode,
  buildWhatsAppLink,
  DEFAULT_PHONE_DIAL_CODE,
  detectPhoneDialCode,
  normalizePhoneForWhatsApp,
  PHONE_COUNTRY_PRESETS,
} from '../services/whatsapp';
import { 
  Plus, User, Car, Phone, Trash2, Edit2, XCircle, Star, Hash, Activity, 
  X, Power, CheckCircle, Clock, Trophy, Map, DollarSign, TrendingUp, 
  Medal, Download, Copy, Check, Info, Users, ExternalLink, PhoneForwarded,
  Fuel, Search, UserX, AlertCircle, ArrowUpRight, List as ListIcon, LayoutGrid, Maximize2, Minimize2
} from 'lucide-react';

const ownershipLabelMap = {
  COMPANY_FLEET: 'Company Fleet',
  OWNER_DRIVER: 'Owner Driver',
  RENTAL: 'Rental',
} as const;

const responsibilityLabelMap = {
  COMPANY: 'Company',
  DRIVER: 'Driver',
  SHARED: 'Shared',
} as const;

export const DriversPage: React.FC = () => {
  const { drivers, trips, addDriver, editDriver, removeDriver } = useStore();
  const [metricsWindow, setMetricsWindow] = useState<'TODAY' | '7D' | '30D' | 'ALL'>('ALL');
  const [desktopView, setDesktopView] = useState<'TABLE' | 'GRID'>('TABLE');
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [isTableFullView, setIsTableFullView] = useState(false);

  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [phoneIntlEnabled, setPhoneIntlEnabled] = useState(false);
  const [phoneDialCode, setPhoneDialCode] = useState(DEFAULT_PHONE_DIAL_CODE);
  const [phoneUseCustomDialCode, setPhoneUseCustomDialCode] = useState(false);
  const [phoneCustomDialCode, setPhoneCustomDialCode] = useState('');
  const [carModel, setCarModel] = useState('');
  const [plateNumber, setPlateNumber] = useState('');
  const [status, setStatus] = useState<'ACTIVE' | 'INACTIVE'>('ACTIVE');
  const [currentStatus, setCurrentStatus] = useState<DriverAvailability>('OFF_DUTY');
  const [actionMessage, setActionMessage] = useState<string>('');
  const [actionTone, setActionTone] = useState<'SUCCESS' | 'ERROR'>('SUCCESS');

  const { rankedDrivers, fleetStats } = useMemo(() => {
    const now = new Date();
    const windowStart = metricsWindow === 'TODAY'
      ? subDays(now, 0)
      : metricsWindow === '7D'
        ? subDays(now, 6)
        : metricsWindow === '30D'
          ? subDays(now, 29)
          : null;
    const inWindow = (tripDateIso: string): boolean => {
      const parsedDate = parseISO(tripDateIso);
      if (Number.isNaN(parsedDate.getTime())) return false;
      if (metricsWindow === 'TODAY') return isToday(parsedDate);
      if (metricsWindow === 'ALL') return true;
      return windowStart ? parsedDate >= windowStart : true;
    };

    let totalFleetRevenue = 0;
    let totalFleetDistance = 0;
    let activeUnitsCount = 0;

    const driversWithStats = drivers.map(driver => {
      const driverTrips = trips.filter(t => t.driverId === driver.id && t.status === TripStatus.COMPLETED && inWindow(t.tripDate || t.createdAt));
      const totalRevenue = driverTrips.reduce((acc, t) => acc + (t.fareUsd || 0), 0);
      const totalDistance = driverTrips.reduce((acc, t) => acc + (t.distanceKm || 0), 0);
      const totalTrips = driverTrips.length;
      const totalRating = driverTrips.reduce((acc, t) => acc + (t.rating || 0), 0);
      const avgRating = totalTrips > 0 ? (totalRating / totalTrips).toFixed(1) : '—';
      
      // Calculate Profitability Index: Total Revenue - Gas Expenses
      const profitabilityIndex = totalRevenue - (driver.totalGasSpent || 0);

      totalFleetRevenue += totalRevenue;
      totalFleetDistance += totalDistance;
      if (driver.status === 'ACTIVE') activeUnitsCount++;

      return {
        ...driver,
        stats: { totalRevenue, totalDistance, totalTrips, avgRating, profitabilityIndex }
      };
    });

    const filtered = driversWithStats.filter(d => 
      d.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      d.plateNumber.toLowerCase().includes(searchTerm.toLowerCase()) ||
      d.carModel.toLowerCase().includes(searchTerm.toLowerCase())
    );

    return {
      rankedDrivers: filtered.sort((a, b) => b.stats.totalRevenue - a.stats.totalRevenue),
      fleetStats: { totalRevenue: totalFleetRevenue, totalDistance: totalFleetDistance, activeUnits: activeUnitsCount, totalUnits: drivers.length }
    };
  }, [drivers, trips, searchTerm, metricsWindow]);

  const availabilityConfig = {
    AVAILABLE: { label: 'Active', color: 'text-emerald-500', bg: 'bg-emerald-50 dark:bg-emerald-900/40', border: 'border-emerald-100 dark:border-emerald-800' },
    BUSY: { label: 'Occupied', color: 'text-amber-500', bg: 'bg-amber-50 dark:bg-amber-900/40', border: 'border-amber-100 dark:border-amber-800' },
    OFF_DUTY: { label: 'Standby', color: 'text-slate-400', bg: 'bg-slate-50 dark:bg-brand-900', border: 'border-slate-200 dark:border-brand-800' },
  };

  const showActionMessage = (message: string, tone: 'SUCCESS' | 'ERROR') => {
    setActionMessage(message);
    setActionTone(tone);
    setTimeout(() => setActionMessage(''), 2400);
  };

  useEffect(() => {
    const isTypingTarget = (target: EventTarget | null): boolean => {
      if (!(target instanceof HTMLElement)) return false;
      const tag = target.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || Boolean(target.closest('[contenteditable="true"]'));
    };

    const handleTableHotkeys = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return;

      if (event.key === 'Escape') {
        setIsTableFullView(false);
        return;
      }

      if (event.key.toLowerCase() === 'f' && !event.metaKey && !event.ctrlKey && !event.altKey && desktopView === 'TABLE') {
        event.preventDefault();
        setIsTableFullView(prev => !prev);
      }
    };

    window.addEventListener('keydown', handleTableHotkeys);
    return () => window.removeEventListener('keydown', handleTableHotkeys);
  }, [desktopView]);

  useEffect(() => {
    if (desktopView !== 'TABLE') {
      setIsTableFullView(false);
    }
  }, [desktopView]);

  useEffect(() => {
    if (isTableFullView) {
      document.body.classList.add('fleet-table-fullview');
    } else {
      document.body.classList.remove('fleet-table-fullview');
    }

    return () => {
      document.body.classList.remove('fleet-table-fullview');
    };
  }, [isTableFullView]);

  const normalizePlate = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const phonePopularPresets = PHONE_COUNTRY_PRESETS;

  const resolvedCustomDialCode = phoneCustomDialCode.replace(/\D/g, '');
  const selectedIntlDialCode = phoneUseCustomDialCode
    ? (resolvedCustomDialCode || phoneDialCode || DEFAULT_PHONE_DIAL_CODE)
    : phoneDialCode;
  const phoneEffectiveDialCode = phoneIntlEnabled ? selectedIntlDialCode : DEFAULT_PHONE_DIAL_CODE;

  const openDriverWhatsApp = (phoneNumber: string) => {
    const link = buildWhatsAppLink(phoneNumber);
    if (!link) {
      showActionMessage('Valid WhatsApp phone is required for this unit.', 'ERROR');
      return;
    }
    window.open(link, '_blank', 'noopener,noreferrer');
  };

  const handleAvailabilityChange = (driver: Driver, nextStatus: DriverAvailability) => {
    if (driver.status !== 'ACTIVE' && nextStatus !== 'OFF_DUTY') {
      showActionMessage('Inactive units can only be set to Standby.', 'ERROR');
      editDriver({ ...driver, currentStatus: 'OFF_DUTY' });
      return;
    }
    editDriver({ ...driver, currentStatus: nextStatus });
  };

  const resetForm = () => {
    setName(''); setPhone(''); setCarModel(''); setPlateNumber(''); setStatus('ACTIVE'); setCurrentStatus('OFF_DUTY');
    setPhoneIntlEnabled(false);
    setPhoneDialCode(DEFAULT_PHONE_DIAL_CODE);
    setPhoneUseCustomDialCode(false);
    setPhoneCustomDialCode('');
    setEditingId(null); setIsFormOpen(false);
  };

  const handleEditClick = (driver: Driver) => {
    setName(driver.name);
    setPhone(driver.phone);
    const detectedDialCode = detectPhoneDialCode(driver.phone) || DEFAULT_PHONE_DIAL_CODE;
    const isKnownPreset = phonePopularPresets.some(option => option.dialCode === detectedDialCode);
    const isNonLebanese = detectedDialCode !== DEFAULT_PHONE_DIAL_CODE;
    setPhoneIntlEnabled(isNonLebanese);
    if (isKnownPreset) {
      setPhoneDialCode(detectedDialCode);
      setPhoneUseCustomDialCode(false);
      setPhoneCustomDialCode('');
    } else {
      setPhoneDialCode(DEFAULT_PHONE_DIAL_CODE);
      setPhoneUseCustomDialCode(true);
      setPhoneCustomDialCode(detectedDialCode);
    }
    setCarModel(driver.carModel);
    setPlateNumber(driver.plateNumber);
    setStatus(driver.status);
    setCurrentStatus(driver.currentStatus);
    setEditingId(driver.id);
    setIsFormOpen(true);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const normalizedName = name.trim();
    const normalizedPhone = phone.trim();
    const normalizedCarModel = carModel.trim();
    const normalizedPlateInput = plateNumber.trim();

    if (!normalizedName || !normalizedPhone || !normalizedCarModel || !normalizedPlateInput) {
      showActionMessage('All unit identity fields are required.', 'ERROR');
      return;
    }

    const canonicalPhone = normalizePhoneForWhatsApp(normalizedPhone, { defaultDialCode: phoneEffectiveDialCode });
    if (!canonicalPhone) {
      showActionMessage('Enter a valid WhatsApp-capable phone number.', 'ERROR');
      return;
    }

    const hasDuplicatePhone = drivers.some(driver => {
      if (editingId && driver.id === editingId) return false;
      const existing = normalizePhoneForWhatsApp(driver.phone, { defaultDialCode: DEFAULT_PHONE_DIAL_CODE });
      const incoming = canonicalPhone;
      return !!existing && !!incoming && existing === incoming;
    });

    if (hasDuplicatePhone) {
      showActionMessage('Phone number already belongs to another unit.', 'ERROR');
      return;
    }

    const incomingPlate = normalizePlate(normalizedPlateInput);
    const hasDuplicatePlate = drivers.some(driver => {
      if (editingId && driver.id === editingId) return false;
      return normalizePlate(driver.plateNumber) === incomingPlate;
    });

    if (hasDuplicatePlate) {
      showActionMessage('Plate number already exists in fleet.', 'ERROR');
      return;
    }

    const existing = editingId ? drivers.find(d => d.id === editingId) : null;
    const safeCurrentStatus = status === 'INACTIVE' ? 'OFF_DUTY' : currentStatus;
    
    const driverData: Driver = {
      id: editingId || Date.now().toString(),
      name: normalizedName,
      phone: canonicalPhone,
      carModel: normalizedCarModel,
      plateNumber: normalizedPlateInput,
      status,
      currentStatus: safeCurrentStatus,
      vehicleOwnership: existing?.vehicleOwnership || 'COMPANY_FLEET',
      fuelCostResponsibility: existing?.fuelCostResponsibility || 'COMPANY',
      maintenanceResponsibility: existing?.maintenanceResponsibility || 'COMPANY',
      joinedAt: existing ? existing.joinedAt : new Date().toISOString(),
      baseMileage: existing ? existing.baseMileage : 0,
      lastOilChangeKm: existing ? existing.lastOilChangeKm : 0,
      lastCheckupKm: existing ? existing.lastCheckupKm : 0,
      totalGasSpent: existing ? existing.totalGasSpent : 0,
      lastRefuelKm: existing ? existing.lastRefuelKm : 0,
      fuelRangeKm: existing ? existing.fuelRangeKm : 500,
      fuelLogs: existing?.fuelLogs || [],
      companyShareOverridePercent: existing?.companyShareOverridePercent,
    };

    if (editingId) editDriver(driverData); else addDriver(driverData);
    showActionMessage(editingId ? 'Unit profile updated.' : 'Unit onboarded successfully.', 'SUCCESS');
    resetForm();
  };

  const handleRemoveDriver = (driver: Driver) => {
    const assignedTrips = trips.filter(t => t.driverId === driver.id).length;
    if (assignedTrips > 0) {
      showActionMessage(`Cannot remove ${driver.name}. Unit is linked to ${assignedTrips} mission(s).`, 'ERROR');
      return;
    }

    const confirmed = window.confirm(`Remove unit ${driver.name} (${driver.plateNumber})?`);
    if (!confirmed) return;

    removeDriver(driver.id);
    showActionMessage('Unit removed successfully.', 'SUCCESS');
  };

  const escapeCsvCell = (value: unknown): string => {
    const raw = String(value ?? '');
    if (!/[",\n]/.test(raw)) return raw;
    return `"${raw.replace(/"/g, '""')}"`;
  };

  const handleExportFleetRosterCsv = () => {
    if (rankedDrivers.length === 0) {
      showActionMessage('No units available for export.', 'ERROR');
      return;
    }

    const headers = [
      'driver_id',
      'name',
      'phone',
      'car_model',
      'plate_number',
      'status',
      'availability',
      'vehicle_ownership',
      'fuel_responsibility',
      'maintenance_responsibility',
      'completed_trips',
      'distance_km',
      'revenue_usd',
      'profitability_index_usd',
      'avg_rating',
      'metrics_window',
      'search_scope',
    ];

    const rows = rankedDrivers.map(driver => [
      driver.id,
      driver.name,
      driver.phone,
      driver.carModel,
      driver.plateNumber,
      driver.status,
      driver.currentStatus,
      driver.vehicleOwnership,
      driver.fuelCostResponsibility,
      driver.maintenanceResponsibility,
      driver.stats.totalTrips,
      Math.round(driver.stats.totalDistance),
      Number(driver.stats.totalRevenue || 0).toFixed(2),
      Number(driver.stats.profitabilityIndex || 0).toFixed(2),
      driver.stats.avgRating,
      metricsWindow,
      searchTerm.trim() ? 'FILTERED' : 'ALL',
    ].map(escapeCsvCell).join(','));

    const csv = [headers.map(escapeCsvCell).join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `fleet-roster-${searchTerm.trim() ? 'filtered' : 'all'}-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);

    showActionMessage(`Fleet roster exported (${rankedDrivers.length} units).`, 'SUCCESS');
  };

  return (
    <div className="app-page-shell p-4 md:p-6 bg-slate-50 dark:bg-brand-950 min-h-full transition-colors duration-300">
      
      {/* Fleet Overview */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <div className="bg-white dark:bg-brand-900 p-4 rounded-2xl border border-slate-200 dark:border-brand-800 flex items-center space-x-4">
          <div className="p-3 bg-brand-50 dark:bg-blue-900/30 rounded-xl text-blue-600"><DollarSign size={20}/></div>
          <div>
            <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Fleet Rev</p>
            <p className="text-lg font-black text-brand-900 dark:text-slate-100">${fleetStats.totalRevenue.toLocaleString()}</p>
          </div>
        </div>
        <div className="bg-white dark:bg-brand-900 p-4 rounded-2xl border border-slate-200 dark:border-brand-800 flex items-center space-x-4">
          <div className="p-3 bg-gold-50 dark:bg-gold-900/30 rounded-xl text-gold-600"><Map size={20}/></div>
          <div>
            <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Global Dist</p>
            <p className="text-lg font-black text-brand-900 dark:text-slate-100">{Math.round(fleetStats.totalDistance).toLocaleString()} <span className="text-[10px]">km</span></p>
          </div>
        </div>
        <div className="bg-white dark:bg-brand-900 p-4 rounded-2xl border border-slate-200 dark:border-brand-800 flex items-center space-x-4">
          <div className="p-3 bg-emerald-50 dark:bg-emerald-900/30 rounded-xl text-emerald-600"><Activity size={20}/></div>
          <div>
            <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Units Online</p>
            <p className="text-lg font-black text-brand-900 dark:text-slate-100">{fleetStats.activeUnits} <span className="text-slate-400 font-normal">/ {fleetStats.totalUnits}</span></p>
          </div>
        </div>
        <div className="bg-white dark:bg-brand-900 p-4 rounded-2xl border border-slate-200 dark:border-brand-800 flex items-center space-x-4">
          <div className="p-3 bg-brand-900 dark:bg-brand-950 rounded-xl text-gold-400"><Trophy size={20}/></div>
          <div>
            <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Fleet Lead</p>
            <p className="text-sm font-black text-brand-900 dark:text-slate-100 truncate max-w-[100px]">{rankedDrivers[0]?.name || '—'}</p>
          </div>
        </div>
      </div>

      <div className="driver-toolbar flex flex-col md:flex-row justify-between items-start md:items-center mb-8 sticky top-0 bg-slate-50 dark:bg-brand-950 z-10 pt-2 pb-6 gap-4">
        <div>
          <h2 className="text-2xl font-black text-brand-900 dark:text-slate-100 uppercase tracking-tight">Fleet Command</h2>
          <p className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest mt-1">Real-time personnel monitoring</p>
        </div>
        <div className="flex flex-col sm:flex-row items-center gap-3 w-full md:w-auto">
          <div className="flex items-center gap-1 rounded-xl border border-slate-200 dark:border-brand-800 bg-white dark:bg-brand-900 p-1 w-full sm:w-auto">
            {(['TODAY', '7D', '30D', 'ALL'] as const).map(window => (
              <button
                key={window}
                type="button"
                onClick={() => setMetricsWindow(window)}
                className={`h-8 px-2.5 rounded-lg text-[8px] font-black uppercase tracking-widest transition-colors ${metricsWindow === window ? 'bg-brand-900 text-gold-400 dark:bg-brand-800' : 'text-slate-500 dark:text-slate-300'}`}
              >
                {window}
              </button>
            ))}
          </div>
          <div className="relative w-full sm:w-64">
             <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
             <input 
               type="text" 
               placeholder="Search units..." 
               value={searchTerm}
               onChange={(e) => setSearchTerm(e.target.value)}
               className="w-full bg-white dark:bg-brand-900 border border-slate-200 dark:border-brand-800 rounded-xl h-10 pl-9 text-[10px] font-black uppercase tracking-widest"
             />
          </div>
          <div className="hidden md:flex items-center gap-1 rounded-xl border border-slate-200 dark:border-brand-800 bg-white dark:bg-brand-900 p-1">
            <button
              type="button"
              onClick={() => setDesktopView('TABLE')}
              className={`h-8 px-2.5 rounded-lg text-[8px] font-black uppercase tracking-widest inline-flex items-center gap-1.5 transition-colors ${desktopView === 'TABLE' ? 'bg-brand-900 text-gold-400 dark:bg-brand-800' : 'text-slate-500 dark:text-slate-300'}`}
            >
              <ListIcon size={12} />
              List
            </button>
            <button
              type="button"
              onClick={() => setDesktopView('GRID')}
              className={`h-8 px-2.5 rounded-lg text-[8px] font-black uppercase tracking-widest inline-flex items-center gap-1.5 transition-colors ${desktopView === 'GRID' ? 'bg-brand-900 text-gold-400 dark:bg-brand-800' : 'text-slate-500 dark:text-slate-300'}`}
            >
              <LayoutGrid size={12} />
              Grid
            </button>
            {desktopView === 'TABLE' && (
              <button
                type="button"
                onClick={() => setIsTableFullView(prev => !prev)}
                title={isTableFullView ? 'Exit full view (Esc)' : 'Open full view'}
                className={`h-8 px-2.5 rounded-lg text-[8px] font-black uppercase tracking-widest inline-flex items-center gap-1.5 transition-colors ${isTableFullView ? 'bg-brand-900 text-gold-400 dark:bg-brand-800' : 'text-slate-500 dark:text-slate-300 hover:text-brand-900 dark:hover:text-gold-400'}`}
              >
                {isTableFullView ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
                Full
              </button>
            )}
          </div>
          <Button onClick={handleExportFleetRosterCsv} variant="outline" className="h-10 px-4 w-full sm:w-auto">
            <Download size={14} className="mr-2" />
            Export CSV
          </Button>
          <Button onClick={() => setIsFormOpen(true)} variant="gold" className="h-10 px-4 shadow-lg shadow-gold-500/20 w-full sm:w-auto">
            <Plus size={16} className="mr-2" />
            Onboard Unit
          </Button>
        </div>
      </div>

      {actionMessage && (
        <div role="status" aria-live="polite" className={`mb-6 rounded-xl border px-4 py-3 text-[10px] font-black uppercase tracking-widest ${actionTone === 'SUCCESS' ? 'bg-emerald-50 border-emerald-100 text-emerald-700 dark:bg-emerald-900/20 dark:border-emerald-800/50 dark:text-emerald-400' : 'bg-red-50 border-red-100 text-red-700 dark:bg-red-900/20 dark:border-red-800/50 dark:text-red-400'}`}>
          {actionMessage}
        </div>
      )}

      {/* Desktop Table View */}
      {desktopView === 'TABLE' && (
      <div className={isTableFullView ? 'fixed inset-0 z-[9999] bg-slate-50 dark:bg-brand-950 p-4 md:p-6 flex flex-col overflow-hidden' : ''}>
      {isTableFullView && (
        <div className="mb-3 flex items-center justify-between shrink-0">
          <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-500 dark:text-slate-300">Fleet Command · Full View</p>
          <button
            type="button"
            onClick={() => setIsTableFullView(false)}
            className="h-8 px-3 rounded-lg border border-slate-200 dark:border-brand-800 bg-white dark:bg-brand-900 text-[8px] font-black uppercase tracking-widest text-slate-600 dark:text-slate-300 inline-flex items-center gap-1.5"
          >
            <Minimize2 size={12} />
            Exit Full View
          </button>
        </div>
      )}
      <HorizontalScrollArea
        className={`${isTableFullView ? 'block flex-1 min-h-0 overflow-hidden bg-white dark:bg-brand-900 rounded-2xl border border-slate-200 dark:border-brand-800 shadow-2xl' : 'hidden md:block bg-white dark:bg-brand-900 shadow-xl rounded-3xl border border-slate-200 dark:border-brand-800'}`}
        viewportClassName={isTableFullView ? 'rounded-2xl h-full min-h-0' : 'rounded-3xl'}
      >
        <table className="min-w-[1080px] w-full divide-y divide-slate-100 dark:divide-brand-800">
          <thead className="bg-slate-50 dark:bg-brand-950">
            <tr>
              <th className="px-6 py-5 text-left text-[10px] font-black text-slate-400 uppercase tracking-widest w-12">Rank</th>
              <th className="px-6 py-5 text-left text-[10px] font-black text-slate-400 uppercase tracking-widest">Fleet Unit</th>
              <th className="px-6 py-4 text-left text-[10px] font-black text-slate-400 uppercase tracking-widest">Operational State</th>
              <th className="px-6 py-4 text-left text-[10px] font-black text-slate-400 uppercase tracking-widest">Performance KPIs</th>
              <th className="px-6 py-4 text-right text-[10px] font-black text-slate-400 uppercase tracking-widest">Control</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-brand-800">
            {rankedDrivers.length > 0 ? rankedDrivers.map((driver, index) => {
              const avail = availabilityConfig[driver.currentStatus] || availabilityConfig['OFF_DUTY'];
              
              return (
                <tr key={driver.id} className="hover:bg-slate-50 dark:hover:bg-brand-800/40 transition-colors group">
                  <td className="px-6 py-5 text-center">
                    {index === 0 && searchTerm === '' ? <Trophy size={18} className="text-gold-500 mx-auto"/> : <span className="text-[10px] font-black text-slate-300">#{index+1}</span>}
                  </td>
                  <td className="px-6 py-5 whitespace-nowrap">
                    <div className="flex items-center">
                      <div className="h-10 w-10 rounded-xl bg-brand-900 flex items-center justify-center font-black text-gold-400 text-xs shadow-sm">
                        {driver.name.charAt(0)}
                      </div>
                      <div className="ml-4">
                        <span className="text-sm font-black text-brand-900 dark:text-slate-100">{driver.name}</span>
                        <p className="text-[9px] font-bold text-slate-400">{driver.carModel} • {driver.plateNumber}</p>
                        <div className="mt-1 flex items-center gap-1.5 flex-wrap">
                          <span className="text-[8px] font-black px-1.5 py-0.5 rounded border uppercase tracking-widest border-slate-300 text-slate-600 bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:bg-slate-900/20">
                            {ownershipLabelMap[driver.vehicleOwnership || 'COMPANY_FLEET']}
                          </span>
                          <span className="text-[8px] font-black px-1.5 py-0.5 rounded border uppercase tracking-widest border-amber-300 text-amber-700 bg-amber-50 dark:border-amber-900/40 dark:text-amber-300 dark:bg-amber-900/10">
                            Fuel {responsibilityLabelMap[driver.fuelCostResponsibility || 'COMPANY']}
                          </span>
                          <span className="text-[8px] font-black px-1.5 py-0.5 rounded border uppercase tracking-widest border-blue-300 text-blue-700 bg-blue-50 dark:border-blue-900/40 dark:text-blue-300 dark:bg-blue-900/10">
                            Maint {responsibilityLabelMap[driver.maintenanceResponsibility || 'COMPANY']}
                          </span>
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="px-6 py-4">
                    <div className="flex flex-col space-y-1">
                      <div className="flex items-center space-x-2">
                        <div className={`w-1.5 h-1.5 rounded-full ${avail.color.replace('text-', 'bg-')} ${driver.currentStatus === 'AVAILABLE' ? 'animate-pulse' : ''}`} />
                        <span className={`text-[9px] font-black uppercase tracking-widest ${avail.color}`}>{avail.label}</span>
                      </div>
                      <select value={driver.currentStatus} onChange={(e) => handleAvailabilityChange(driver, e.target.value as DriverAvailability)} className="text-[8px] font-black uppercase tracking-widest border-none bg-transparent p-0 focus:ring-0 cursor-pointer text-slate-400">
                        <option value="AVAILABLE">Make Active</option>
                        <option value="BUSY">Make Occupied</option>
                        <option value="OFF_DUTY">Go Standby</option>
                      </select>
                    </div>
                  </td>
                  <td className="px-6 py-4">
                    <div className="flex items-center space-x-8">
                       <div className="text-left">
                          <p className="text-[8px] font-black text-slate-400 uppercase tracking-widest mb-1">Distance</p>
                          <p className="text-[10px] font-black text-blue-500 uppercase">{Math.round(driver.stats.totalDistance).toLocaleString()} KM</p>
                       </div>
                       <div className="text-left">
                          <p className="text-[8px] font-black text-slate-400 uppercase tracking-widest mb-1">Revenue</p>
                          <p className="text-[10px] font-black text-emerald-500 uppercase">${driver.stats.totalRevenue.toLocaleString()}</p>
                       </div>
                       <div className="text-left">
                          <p className="text-[8px] font-black text-slate-400 uppercase tracking-widest mb-1">Profit Index</p>
                          <div className="flex items-center space-x-1.5">
                             <p className={`text-[10px] font-black uppercase ${driver.stats.profitabilityIndex >= 0 ? 'text-gold-600' : 'text-red-500'}`}>
                                ${driver.stats.profitabilityIndex.toLocaleString()}
                             </p>
                             {driver.stats.profitabilityIndex > 0 && <ArrowUpRight size={10} className="text-gold-600" />}
                          </div>
                       </div>
                    </div>
                  </td>
                  <td className="px-6 py-4 text-right">
                    <div className="flex items-center justify-end space-x-1">
                      <button type="button" onClick={() => openDriverWhatsApp(driver.phone)} title="Open WhatsApp" aria-label={`Open WhatsApp for ${driver.name}`} className="p-2 text-blue-600 hover:bg-blue-50 dark:hover:bg-brand-800 rounded-lg transition-colors"><Phone size={14} /></button>
                      <button type="button" onClick={() => handleEditClick(driver)} title="Edit unit" aria-label={`Edit ${driver.name}`} className="p-2 text-slate-400 hover:text-brand-900 dark:hover:text-white rounded-lg transition-colors"><Edit2 size={14}/></button>
                      <button type="button" onClick={() => handleRemoveDriver(driver)} title="Remove unit" aria-label={`Remove ${driver.name}`} className="p-2 text-slate-200 hover:text-red-500 rounded-lg transition-colors"><Trash2 size={14}/></button>
                    </div>
                  </td>
                </tr>
              );
            }) : (
              <tr>
                <td colSpan={5} className="py-20 text-center">
                   <UserX size={48} className="mx-auto text-slate-300 dark:text-brand-800 mb-4" />
                   <h3 className="text-sm font-black text-slate-400 uppercase tracking-widest">No Operational Units Found</h3>
                   <p className="text-[9px] font-bold text-slate-400 uppercase tracking-tighter mt-1">Adjust search parameters or onboard new unit</p>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </HorizontalScrollArea>
      </div>
      )}

      {/* Desktop Grid View */}
      {desktopView === 'GRID' && (
        <div className="hidden md:grid grid-cols-2 xl:grid-cols-3 gap-4">
          {rankedDrivers.length > 0 ? rankedDrivers.map((driver, index) => {
            const avail = availabilityConfig[driver.currentStatus] || availabilityConfig['OFF_DUTY'];
            return (
              <div key={driver.id} className="bg-white dark:bg-brand-900 p-5 rounded-2xl border border-slate-200 dark:border-brand-800 shadow-sm relative overflow-hidden">
                <div className={`absolute top-0 left-0 w-1 h-full ${avail.color.replace('text-', 'bg-')}`} />
                <div className="flex justify-between items-start mb-4">
                  <div className="flex items-center space-x-3">
                    <div className="w-10 h-10 rounded-xl bg-brand-900 flex items-center justify-center text-gold-400 font-black">{driver.name.charAt(0)}</div>
                    <div>
                      <h4 className="text-sm font-black text-brand-900 dark:text-white uppercase leading-none">{driver.name}</h4>
                      <p className="text-[9px] font-bold text-slate-400 mt-1 uppercase tracking-widest">{driver.carModel} · {driver.plateNumber}</p>
                    </div>
                  </div>
                  <div className="text-right">
                    {index === 0 && searchTerm === '' ? <Trophy size={14} className="text-gold-500 ml-auto" /> : <p className="text-[9px] font-black text-slate-400">#{index + 1}</p>}
                    <p className="text-[10px] font-black text-emerald-500 mt-1">${driver.stats.totalRevenue.toLocaleString()}</p>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4 pt-4 border-t border-slate-50 dark:border-brand-800">
                  <div>
                    <p className="text-[8px] font-black text-slate-400 uppercase tracking-widest mb-1">Status</p>
                    <span className={`text-[9px] font-black uppercase ${avail.color}`}>{avail.label}</span>
                  </div>
                  <div className="text-right">
                    <p className="text-[8px] font-black text-slate-400 uppercase tracking-widest mb-1">Profit Index</p>
                    <p className={`text-[9px] font-black ${driver.stats.profitabilityIndex >= 0 ? 'text-gold-600' : 'text-red-500'}`}>${driver.stats.profitabilityIndex.toLocaleString()}</p>
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-2 pt-4 border-t border-slate-50 dark:border-brand-800 mt-4">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-[8px] font-black px-1.5 py-0.5 rounded border uppercase tracking-widest border-slate-300 text-slate-600 bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:bg-slate-900/20">
                      {ownershipLabelMap[driver.vehicleOwnership || 'COMPANY_FLEET']}
                    </span>
                    <span className="text-[8px] font-black px-1.5 py-0.5 rounded border uppercase tracking-widest border-amber-300 text-amber-700 bg-amber-50 dark:border-amber-900/40 dark:text-amber-300 dark:bg-amber-900/10">
                      Fuel {responsibilityLabelMap[driver.fuelCostResponsibility || 'COMPANY']}
                    </span>
                    <span className="text-[8px] font-black px-1.5 py-0.5 rounded border uppercase tracking-widest border-blue-300 text-blue-700 bg-blue-50 dark:border-blue-900/40 dark:text-blue-300 dark:bg-blue-900/10">
                      Maint {responsibilityLabelMap[driver.maintenanceResponsibility || 'COMPANY']}
                    </span>
                  </div>
                </div>

                <div className="pt-4 border-t border-slate-50 dark:border-brand-800 mt-4">
                  <p className="text-[8px] font-black text-slate-400 uppercase tracking-widest mb-2">Availability</p>
                  <select
                    value={driver.currentStatus}
                    onChange={(e) => handleAvailabilityChange(driver, e.target.value as DriverAvailability)}
                    className="w-full text-[9px] font-black uppercase tracking-widest rounded-lg border border-slate-200 dark:border-brand-800 bg-slate-50 dark:bg-brand-950 p-2"
                  >
                    <option value="AVAILABLE">Make Active</option>
                    <option value="BUSY">Make Occupied</option>
                    <option value="OFF_DUTY">Go Standby</option>
                  </select>
                </div>

                <div className="flex justify-end items-center mt-4 space-x-2">
                  <button type="button" onClick={() => handleEditClick(driver)} aria-label={`Edit ${driver.name}`} className="p-2 text-slate-400"><Edit2 size={16}/></button>
                  <button type="button" onClick={() => openDriverWhatsApp(driver.phone)} aria-label={`Open WhatsApp for ${driver.name}`} className="p-2 text-blue-500"><Phone size={16}/></button>
                  <button type="button" onClick={() => handleRemoveDriver(driver)} aria-label={`Remove ${driver.name}`} className="p-2 text-red-400"><Trash2 size={16}/></button>
                </div>
              </div>
            );
          }) : (
            <div className="col-span-2 xl:col-span-3 py-20 text-center bg-white dark:bg-brand-900 rounded-3xl border border-slate-200 dark:border-brand-800">
              <UserX size={40} className="mx-auto text-slate-200 dark:text-brand-800 mb-3" />
              <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">No Matches</p>
            </div>
          )}
        </div>
      )}

      {/* Mobile Card View */}
      <div className="md:hidden space-y-4">
        {rankedDrivers.length > 0 ? rankedDrivers.map((driver, index) => {
          const avail = availabilityConfig[driver.currentStatus] || availabilityConfig['OFF_DUTY'];
          return (
            <div key={driver.id} className="bg-white dark:bg-brand-900 p-5 rounded-2xl border border-slate-200 dark:border-brand-800 shadow-sm relative overflow-hidden">
              <div className={`absolute top-0 left-0 w-1 h-full ${avail.color.replace('text-', 'bg-')}`} />
              <div className="flex justify-between items-start mb-4">
                <div className="flex items-center space-x-3">
                   <div className="w-10 h-10 rounded-xl bg-brand-900 flex items-center justify-center text-gold-400 font-black">{driver.name.charAt(0)}</div>
                   <div>
                      <h4 className="text-sm font-black text-brand-900 dark:text-white uppercase leading-none">{driver.name}</h4>
                      <p className="text-[9px] font-bold text-slate-400 mt-1 uppercase tracking-widest">{driver.plateNumber}</p>
                   </div>
                </div>
                <div className="text-right">
                   <p className="text-[10px] font-black text-brand-900 dark:text-gold-500">${driver.stats.totalRevenue}</p>
                   <p className="text-[8px] font-bold text-slate-400 uppercase tracking-widest mt-0.5">Yield</p>
                </div>
              </div>
              
              <div className="grid grid-cols-2 gap-4 pt-4 border-t border-slate-50 dark:border-brand-800">
                 <div>
                    <p className="text-[8px] font-black text-slate-400 uppercase tracking-widest mb-1">Status</p>
                    <span className={`text-[9px] font-black uppercase ${avail.color}`}>{avail.label}</span>
                 </div>
                 <div className="text-right">
                    <p className="text-[8px] font-black text-slate-400 uppercase tracking-widest mb-1">Profit Index</p>
                    <p className="text-[9px] font-black text-gold-600">${driver.stats.profitabilityIndex}</p>
                 </div>
              </div>

              <div className="grid grid-cols-1 gap-2 pt-4 border-t border-slate-50 dark:border-brand-800 mt-4">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-[8px] font-black px-1.5 py-0.5 rounded border uppercase tracking-widest border-slate-300 text-slate-600 bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:bg-slate-900/20">
                    {ownershipLabelMap[driver.vehicleOwnership || 'COMPANY_FLEET']}
                  </span>
                  <span className="text-[8px] font-black px-1.5 py-0.5 rounded border uppercase tracking-widest border-amber-300 text-amber-700 bg-amber-50 dark:border-amber-900/40 dark:text-amber-300 dark:bg-amber-900/10">
                    Fuel {responsibilityLabelMap[driver.fuelCostResponsibility || 'COMPANY']}
                  </span>
                  <span className="text-[8px] font-black px-1.5 py-0.5 rounded border uppercase tracking-widest border-blue-300 text-blue-700 bg-blue-50 dark:border-blue-900/40 dark:text-blue-300 dark:bg-blue-900/10">
                    Maint {responsibilityLabelMap[driver.maintenanceResponsibility || 'COMPANY']}
                  </span>
                </div>
              </div>

              <div className="pt-4 border-t border-slate-50 dark:border-brand-800 mt-4">
                <p className="text-[8px] font-black text-slate-400 uppercase tracking-widest mb-2">Availability</p>
                <select
                  value={driver.currentStatus}
                  onChange={(e) => handleAvailabilityChange(driver, e.target.value as DriverAvailability)}
                  className="w-full text-[9px] font-black uppercase tracking-widest rounded-lg border border-slate-200 dark:border-brand-800 bg-slate-50 dark:bg-brand-950 p-2"
                >
                  <option value="AVAILABLE">Make Active</option>
                  <option value="BUSY">Make Occupied</option>
                  <option value="OFF_DUTY">Go Standby</option>
                </select>
              </div>

              <div className="flex justify-end items-center mt-4 space-x-2">
                 <button type="button" onClick={() => handleEditClick(driver)} aria-label={`Edit ${driver.name}`} className="p-2 text-slate-400"><Edit2 size={16}/></button>
                  <button type="button" onClick={() => openDriverWhatsApp(driver.phone)} aria-label={`Open WhatsApp for ${driver.name}`} className="p-2 text-blue-500"><Phone size={16}/></button>
                  <button type="button" onClick={() => handleRemoveDriver(driver)} aria-label={`Remove ${driver.name}`} className="p-2 text-red-400"><Trash2 size={16}/></button>
              </div>
            </div>
          );
        }) : (
          <div className="py-20 text-center bg-white dark:bg-brand-900 rounded-3xl border border-slate-200 dark:border-brand-800">
             <UserX size={40} className="mx-auto text-slate-200 dark:text-brand-800 mb-3" />
             <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">No Matches</p>
          </div>
        )}
      </div>

      {isFormOpen && (
        <div className="fixed inset-0 bg-brand-950/80 backdrop-blur-sm z-50 flex items-start md:items-center justify-center p-4 overflow-y-auto">
          <div className="bg-white dark:bg-brand-900 rounded-3xl shadow-2xl w-full max-w-md border border-slate-200 dark:border-brand-800 max-h-[calc(100dvh-2rem)] overflow-hidden flex flex-col">
             <div className="bg-slate-50 dark:bg-brand-950 px-6 py-5 border-b dark:border-brand-800 flex justify-between items-center">
                <h3 className="font-black text-brand-900 dark:text-slate-100 uppercase tracking-tight">{editingId ? 'Refine Unit' : 'Onboard Unit'}</h3>
                <button onClick={resetForm} aria-label="Close form" className="p-2 text-slate-400"><X size={24}/></button>
             </div>
             <form onSubmit={handleSubmit} className="p-6 space-y-4 overflow-y-auto">
                <input type="text" required value={name} onChange={e => setName(e.target.value)} className="w-full border border-slate-200 dark:border-brand-800 rounded-xl p-3 h-11 bg-slate-50 dark:bg-brand-950 font-bold" placeholder="Full Name" aria-label="Full Name" />
                <div className="space-y-2">
                  <input
                    type="tel"
                    required
                    value={phone}
                    onChange={e => {
                      const nextPhone = e.target.value;
                      setPhone(nextPhone);
                      const detectedDialCode = detectPhoneDialCode(nextPhone);
                      if (detectedDialCode) {
                        const isKnownPreset = phonePopularPresets.some(option => option.dialCode === detectedDialCode);
                        setPhoneIntlEnabled(detectedDialCode !== DEFAULT_PHONE_DIAL_CODE);
                        if (isKnownPreset) {
                          setPhoneUseCustomDialCode(false);
                          setPhoneDialCode(detectedDialCode);
                        } else {
                          setPhoneUseCustomDialCode(true);
                          setPhoneCustomDialCode(detectedDialCode);
                        }
                      }
                    }}
                    className="w-full border border-slate-200 dark:border-brand-800 rounded-xl p-3 h-11 bg-slate-50 dark:bg-brand-950 font-bold"
                    placeholder="Phone Number"
                    aria-label="Phone Number"
                  />
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => setPhoneIntlEnabled(prev => !prev)}
                      className={`h-8 rounded-lg border text-[8px] font-black uppercase tracking-widest transition-colors ${phoneIntlEnabled ? 'border-blue-300 text-blue-700 bg-blue-50 dark:border-blue-900/40 dark:text-blue-300 dark:bg-blue-900/10' : 'border-emerald-300 text-emerald-700 bg-emerald-50 dark:border-emerald-900/40 dark:text-emerald-300 dark:bg-emerald-900/10'}`}
                    >
                      {phoneIntlEnabled ? 'INTL ON' : 'INTL OFF (LB)'}
                    </button>
                    {phoneIntlEnabled ? (
                      <select
                        value={phoneUseCustomDialCode ? 'OTHER' : phoneDialCode}
                        onChange={event => {
                          const value = event.target.value;
                          if (value === 'OTHER') {
                            setPhoneUseCustomDialCode(true);
                            return;
                          }

                          setPhoneUseCustomDialCode(false);
                          setPhoneDialCode(value);
                          setPhone(prev => applyPhoneDialCode(prev, value));
                        }}
                        className="h-8 rounded-lg border border-slate-200 dark:border-white/10 bg-white dark:bg-brand-950 px-2 text-[8px] font-black uppercase tracking-widest text-slate-600 dark:text-slate-300"
                        aria-label="Select international country code"
                      >
                        {phonePopularPresets.map(option => (
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
                  {phoneIntlEnabled && phoneUseCustomDialCode && (
                    <input
                      type="text"
                      value={phoneCustomDialCode}
                      onChange={event => {
                        const digits = event.target.value.replace(/\D/g, '').slice(0, 4);
                        setPhoneCustomDialCode(digits);
                        if (digits.length > 0) {
                          setPhone(prev => applyPhoneDialCode(prev, digits));
                        }
                      }}
                      className="w-full border border-slate-200 dark:border-brand-800 rounded-xl p-3 h-11 bg-slate-50 dark:bg-brand-950 font-bold"
                      placeholder="Other country code (e.g. 1, 61)"
                      aria-label="Custom country code"
                    />
                  )}
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <input type="text" required value={carModel} onChange={e => setCarModel(e.target.value)} className="w-full border border-slate-200 dark:border-brand-800 rounded-xl p-3 h-11 bg-slate-50 dark:bg-brand-950 font-bold" placeholder="Vehicle Model" aria-label="Vehicle Model" />
                  <input type="text" required value={plateNumber} onChange={e => setPlateNumber(e.target.value)} className="w-full border border-slate-200 dark:border-brand-800 rounded-xl p-3 h-11 bg-slate-50 dark:bg-brand-950 font-bold" placeholder="Plate No." aria-label="Plate Number" />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest px-1 block mb-1">Unit Status</label>
                    <select value={status} onChange={e => setStatus(e.target.value as 'ACTIVE' | 'INACTIVE')} className="w-full border border-slate-200 dark:border-brand-800 rounded-xl h-11 px-3 bg-slate-50 dark:bg-brand-950 font-bold text-xs">
                      <option value="ACTIVE">Active</option>
                      <option value="INACTIVE">Inactive</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-[9px] font-black text-slate-400 uppercase tracking-widest px-1 block mb-1">Availability</label>
                    <select value={currentStatus} onChange={e => setCurrentStatus(e.target.value as DriverAvailability)} className="w-full border border-slate-200 dark:border-brand-800 rounded-xl h-11 px-3 bg-slate-50 dark:bg-brand-950 font-bold text-xs">
                      <option value="AVAILABLE">Available</option>
                      <option value="BUSY">Busy</option>
                      <option value="OFF_DUTY">Off Duty</option>
                    </select>
                  </div>
                </div>
                <div className="pt-4 flex gap-3">
                   <Button type="button" variant="outline" onClick={resetForm} className="flex-1 bg-white">Cancel</Button>
                   <Button type="submit" variant="gold" className="flex-1">{editingId ? 'Update Protocol' : 'Authorize Unit'}</Button>
                </div>
             </form>
          </div>
        </div>
      )}
    </div>
  );
};
