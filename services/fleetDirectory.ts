import { Driver } from '../types';

const normalizeToken = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/[^a-z0-9+\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export const ownershipSearchLabels: Record<Driver['vehicleOwnership'], string> = {
  COMPANY_FLEET: 'Company Fleet',
  OWNER_DRIVER: 'Owner Driver',
  RENTAL: 'Rental',
};

export const responsibilitySearchLabels: Record<Driver['fuelCostResponsibility'], string> = {
  COMPANY: 'Company',
  DRIVER: 'Driver',
  SHARED: 'Shared',
};

export const availabilitySearchLabels: Record<Driver['currentStatus'], string> = {
  AVAILABLE: 'Available',
  BUSY: 'Busy',
  OFF_DUTY: 'Off Duty',
};

export const activeStatusSearchLabels: Record<Driver['status'], string> = {
  ACTIVE: 'Active',
  INACTIVE: 'Inactive',
};

export const tokenizeFleetQuery = (query: string): string[] =>
  normalizeToken(query)
    .split(' ')
    .filter(Boolean);

export const matchesFleetQuery = (searchableText: string, query: string): boolean => {
  const normalized = normalizeToken(searchableText);
  const tokens = tokenizeFleetQuery(query);
  if (tokens.length === 0) return true;
  return tokens.every(token => normalized.includes(token));
};

export const buildDriverSearchText = (driver: Driver): string => {
  const ownershipLabel = ownershipSearchLabels[driver.vehicleOwnership || 'COMPANY_FLEET'];
  const fuelLabel = responsibilitySearchLabels[driver.fuelCostResponsibility || 'COMPANY'];
  const maintenanceLabel = responsibilitySearchLabels[driver.maintenanceResponsibility || 'COMPANY'];
  const availabilityLabel = availabilitySearchLabels[driver.currentStatus || 'OFF_DUTY'];
  const activeLabel = activeStatusSearchLabels[driver.status || 'ACTIVE'];

  return [
    driver.name,
    driver.plateNumber,
    driver.carModel,
    driver.phone,
    ownershipLabel,
    fuelLabel,
    maintenanceLabel,
    availabilityLabel,
    activeLabel,
    driver.vehicleOwnership,
    driver.fuelCostResponsibility,
    driver.maintenanceResponsibility,
    driver.currentStatus,
    driver.status,
  ]
    .filter(Boolean)
    .join(' ');
};
