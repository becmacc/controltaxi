import { Driver, Trip, TripStatus } from '../types';

export interface UnitSnapshotMetrics {
  completedTrips: number;
  totalRevenue: number;
  totalDistance: number;
  profitabilityIndex: number;
  activeTrips: number;
  cancelledTrips: number;
  lastCompletedAt?: string;
}

export const buildUnitSnapshotMetrics = (driver: Driver, trips: Trip[]): UnitSnapshotMetrics => {
  const assignedTrips = trips.filter(trip => trip.driverId === driver.id);
  const completedTrips = assignedTrips.filter(trip => trip.status === TripStatus.COMPLETED);
  const activeTrips = assignedTrips.filter(
    trip => trip.status === TripStatus.CONFIRMED || trip.status === TripStatus.QUOTED
  ).length;
  const cancelledTrips = assignedTrips.filter(trip => trip.status === TripStatus.CANCELLED).length;

  const totalRevenue = completedTrips.reduce((sum, trip) => sum + (trip.fareUsd || 0), 0);
  const totalDistance = completedTrips.reduce((sum, trip) => sum + (trip.distanceKm || 0), 0);
  const profitabilityIndex = totalRevenue - (driver.totalGasSpent || 0);

  const lastCompletedAt = completedTrips
    .map(trip => trip.completedAt || trip.tripDate || trip.createdAt)
    .filter(Boolean)
    .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0];

  return {
    completedTrips: completedTrips.length,
    totalRevenue,
    totalDistance,
    profitabilityIndex,
    activeTrips,
    cancelledTrips,
    lastCompletedAt,
  };
};
