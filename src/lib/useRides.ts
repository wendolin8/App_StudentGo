import { useCallback, useEffect, useState } from 'react';
import { fetchDriverTrips, fetchPassengerRides, type DriverTripGroup, type PassengerRide } from '@/lib/rides';

export function useRides(userId: string, isDriver: boolean) {
  const [rides, setRides] = useState<PassengerRide[]>([]);
  const [groups, setGroups] = useState<DriverTripGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  const reload = useCallback(async () => {
    setLoading(true);
    const [passenger, driver] = await Promise.all([
      fetchPassengerRides(userId),
      isDriver ? fetchDriverTrips(userId) : Promise.resolve({ data: [] as DriverTripGroup[], error: null }),
    ]);
    const message = passenger.error ?? driver.error;
    setFailed(Boolean(message));
    setErrorMessage(message ?? '');
    setRides(passenger.data);
    setGroups(driver.data);
    setLoading(false);
  }, [userId, isDriver]);

  useEffect(() => {
    void reload();
    const timer = window.setInterval(() => { void reload(); }, 15000);
    return () => window.clearInterval(timer);
  }, [reload]);

  return { rides, groups, loading, failed, errorMessage, reload };
}
