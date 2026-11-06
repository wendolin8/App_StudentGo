import { useCallback, useEffect, useState } from 'react';
import { fetchDriverTrips, fetchPassengerRides, type DriverTripGroup, type PassengerRide } from '@/lib/rides';

export function useRides(userId: string, isDriver: boolean) {
  const [rides, setRides] = useState<PassengerRide[]>([]);
  const [groups, setGroups] = useState<DriverTripGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  // Polling keeps the two roles in sync, but it must not redraw the entire
  // Requests page as "loading" every fifteen seconds while someone uses it.
  const reload = useCallback(async (showLoading = true) => {
    if (showLoading) setLoading(true);
    const [passenger, driver] = await Promise.all([
      fetchPassengerRides(userId),
      isDriver ? fetchDriverTrips(userId) : Promise.resolve({ data: [] as DriverTripGroup[], error: null }),
    ]);
    const message = passenger.error ?? driver.error;
    setFailed(Boolean(message));
    setErrorMessage(message ?? '');
    setRides(passenger.data);
    setGroups(driver.data);
    if (showLoading) setLoading(false);
  }, [userId, isDriver]);

  useEffect(() => {
    void reload(true);
    const timer = window.setInterval(() => { void reload(false); }, 15000);
    return () => window.clearInterval(timer);
  }, [reload]);

  return { rides, groups, loading, failed, errorMessage, reload };
}
