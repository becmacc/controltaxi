
export enum TripStatus {
  QUOTED = 'QUOTED',
  CONFIRMED = 'CONFIRMED',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED'
}

export type DriverAvailability = 'AVAILABLE' | 'BUSY' | 'OFF_DUTY';
export type DriverVehicleOwnership = 'COMPANY_FLEET' | 'OWNER_DRIVER' | 'RENTAL';
export type DriverCostResponsibility = 'COMPANY' | 'DRIVER' | 'SHARED';

export interface DriverFuelLogEntry {
  id: string;
  timestamp: string;
  amountUsd: number;
  amountOriginal?: number;
  currency?: 'USD' | 'LBP';
  fxRateSnapshot?: number;
  amountLbp?: number;
  odometerKm?: number;
  note?: string;
}

export type CustomerProfileEventSource = 'TRIP_NOTE' | 'IMPORT' | 'MANUAL' | 'SYNC';
export type CustomerMarketSegment = 'EXPAT' | 'TOURIST' | 'LOCAL_RESIDENT';
export type CustomerGender = 'MALE' | 'FEMALE' | 'UNSPECIFIED';
export type CustomerEntityType = 'BUSINESS' | 'INDIVIDUAL' | 'UNSPECIFIED';

export interface CustomerLocation {
  label: string;
  address: string;
  mapsLink?: string;
  lat?: number;
  lng?: number;
}

export interface CustomerProfileEvent {
  id: string;
  timestamp: string;
  source: CustomerProfileEventSource;
  note: string;
  tripId?: number;
}

export interface Driver {
  id: string;
  name: string;
  phone: string;
  carModel: string;
  plateNumber: string;
  status: 'ACTIVE' | 'INACTIVE';
  currentStatus: DriverAvailability;
  vehicleOwnership: DriverVehicleOwnership;
  fuelCostResponsibility: DriverCostResponsibility;
  maintenanceResponsibility: DriverCostResponsibility;
  joinedAt: string;
  
  // Fleet Intelligence Fields
  baseMileage: number; 
  lastOilChangeKm: number;
  lastCheckupKm: number;
  totalGasSpent: number;

  // Fuel Intelligence
  lastRefuelKm: number; 
  fuelRangeKm: number; // Estimated range on a full tank (default ~500km)
  fuelLogs?: DriverFuelLogEntry[];
  companyShareOverridePercent?: number;
}

export interface Customer {
  id: string;
  name: string;
  phone: string;
  source: 'MANUAL' | 'SYNC' | 'OPERATIONAL';
  isInternational?: boolean;
  marketSegments?: CustomerMarketSegment[];
  gender?: CustomerGender;
  entityType?: CustomerEntityType;
  profession?: string;
  homeLocation?: CustomerLocation;
  businessLocation?: CustomerLocation;
  frequentLocations?: CustomerLocation[];
  createdAt: string;
  notes?: string;
  profileTimeline?: CustomerProfileEvent[];
  lastEnrichedAt?: string;
}

export interface MissionAlert {
  id: string;
  tripId?: number;
  driverId?: string;
  type: 'PICKUP' | 'DROP_OFF' | 'FOLLOW_UP' | 'REFUEL';
  targetTime: string;
  snoozedUntil?: string;
  label: string;
  triggered: boolean;
  customerName?: string;
  driverName?: string;
}

export interface TripStop {
  text: string;
  placeId?: string;
  originalLink?: string;
  lat?: number;
  lng?: number;
}

export type TripPaymentMode = 'CASH' | 'CREDIT';
export type TripSettlementStatus = 'PENDING' | 'SETTLED' | 'RECEIPTED';

export interface Trip {
  id: number;
  createdAt: string; 
  tripDate: string; 
  
  customerName: string;
  customerPhone: string;
  pickupText: string;
  pickupPlaceId: string;
  pickupOriginalLink?: string;
  pickupLat?: number;
  pickupLng?: number;
  
  destinationText: string;
  destinationPlaceId: string;
  destinationOriginalLink?: string;
  destLat?: number;
  destLng?: number;
  stops?: TripStop[];
  
  distanceKm: number;
  distanceText: string;
  durationMin: number;
  durationText: string;
  
  durationInTrafficMin?: number;
  durationInTrafficText?: string;
  trafficIndex?: number;
  surplusMin?: number;
  
  isRoundTrip?: boolean;
  waitTimeHours?: number;
  hourlyWaitRateSnapshot?: number;
  ratePerKmSnapshot?: number;

  specialRequirements?: string[];
  specialRequirementsNotes?: string;

  fareUsd: number;
  fareLbp: number;
  exchangeRateSnapshot: number;
  paymentMode?: TripPaymentMode;
  settlementStatus?: TripSettlementStatus;
  creditLedgerEntryId?: string;
  receiptId?: string;
  settledAt?: string;
  completedAt?: string;
  status: TripStatus;
  notes: string;

  driverId?: string;
  rating?: number;
  feedback?: string;

  // Messaging Audit
  confirmation_sent_at?: string;
  feedback_request_sent_at?: string;
  thank_you_sent_at?: string;
}

export interface DeletedTripRecord {
  archiveId: string;
  deletedAt: string;
  deletedReason: 'CANCELLED_DELETE';
  trip: Trip;
}

export type CreditPartyType = 'CLIENT' | 'DRIVER';
export type CreditCycle = 'WEEKLY' | 'MONTHLY';
export type CreditLedgerStatus = 'OPEN' | 'PAID';

export interface CreditLedgerEntry {
  id: string;
  partyType: CreditPartyType;
  partyId?: string;
  partyName: string;
  cycle: CreditCycle;
  amountUsd: number;
  dueDate?: string;
  notes?: string;
  status: CreditLedgerStatus;
  createdAt: string;
  paidAt?: string;
  receiptId?: string;
}

export interface ReceiptRecord {
  id: string;
  receiptNumber: string;
  ledgerEntryId: string;
  issuedAt: string;
  partyType: CreditPartyType;
  partyName: string;
  cycle: CreditCycle;
  amountUsd: number;
  notes?: string;
}

export interface MessageTemplates {
  trip_confirmation: string;
  feedback_request: string;
  feedback_thanks: string;
}

export interface Settings {
  exchangeRate: number;
  googleMapsApiKey: string;
  googleMapsMapId: string;
  googleMapsMapIdDark: string;
  operatorWhatsApp: string;
  hourlyWaitRate: number;
  ratePerKm: number;
  fuelPriceUsdPerLiter: number;
  ownerDriverCompanySharePercent: number;
  companyCarDriverGasCompanySharePercent: number;
  otherDriverCompanySharePercent: number;
  templates: MessageTemplates;
}

export interface RouteResult {
  distanceKm: number;
  distanceText: string;
  durationMin: number;
  durationText: string;
  pickupAddress: string;
  destinationAddress: string;
  durationInTrafficMin: number;
  durationInTrafficText: string;
  trafficIndex: number;
  surplusMin: number;
}
