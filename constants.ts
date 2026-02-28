
export const DEFAULT_EXCHANGE_RATE = 90000;
export const DEFAULT_RATE_USD_PER_KM = 1.10;
export const DEFAULT_HOURLY_WAIT_RATE = 5;
export const DEFAULT_FUEL_PRICE_USD_PER_LITER = 1.3;
export const APP_NAME = "Control";

export const DEFAULT_TEMPLATES = {
  trip_confirmation: "Andrew's Taxi ✅\nHi {customer_name}, your ride is confirmed.\n🕒 Pickup Time: {trip_datetime_formatted}\n📍 Pickup: {pickup}\n🏁 Destination: {destination}\n🚗 Driver: {driver_name_with_plate}\n⏱ ETA: {eta_text}\n💵 Fare: ${fare_usd} (~{fare_lbp} LBP)\n{details_block}\n\nIf you need any changes, just reply to this chat.",
  feedback_request: "Hi {customer_name}, thank you for riding with us.\nHow was your ride with {driver_name}?\nPlease rate it from 1–5 and share a quick note.\nExample: 5 - very good",
  feedback_thanks: "Thank you {customer_name} for your feedback.\nWe appreciate your time and look forward to serving you again."
};

export const LOCAL_STORAGE_KEYS = {
  TRIPS: 'control_taxi_trips',
  DELETED_TRIPS: 'control_taxi_deleted_trips',
  SETTINGS: 'control_taxi_settings',
  DRIVERS: 'control_taxi_drivers',
  CUSTOMERS: 'control_taxi_customers',
  ALERTS: 'control_taxi_alerts',
  SYNC_EPOCH: 'control_taxi_sync_epoch'
};

export const SPECIAL_REQUIREMENTS = [
  { id: 'quiet', label: 'Quiet ride', short: 'Quiet' },
  { id: 'rest', label: 'Needs rest / sleep', short: 'Sleep' },
  { id: 'luggage', label: 'Extra luggage', short: 'Luggage' },
  { id: 'passenger4', label: '4+ passengers', short: '4+ Pax' },
  { id: 'child_seat', label: 'Child seat', short: 'Child Seat' },
  { id: 'suv', label: 'SUV required', short: 'SUV' },
  { id: 'van', label: 'Van required', short: 'Van' },
  { id: 'pet', label: 'Pet onboard', short: 'Pet' },
  { id: 'wheelchair', label: 'Wheelchair / Access', short: 'Access' },
  { id: 'smoking', label: 'Smoking allowed', short: 'Smoking' },
  { id: 'no_smoking', label: 'Smoking NOT allowed', short: 'No Smoke' },
  { id: 'stops', label: 'Multiple stops', short: 'Stops' },
];
