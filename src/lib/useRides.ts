import { useCallback, useEffect, useState } from 'react';
import { fetchDriverTrips, fetchPassengerRides, type DriverTripGroup, type PassengerRide } from '@/lib/rides';

export function useRides(userId: string, isDriver: boolean) {
  const [rides, setRides] = useState<PassengerRide[]>([]);
  const [groups, setGroups] = useState<DriverTripGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const reload = useCallback(async () => {
    const [passenger, driver] = await Promise.all([
      fetchPassengerRides(userId),
      isDriver ? fetchDriverTrips(userId) : Promise.resolve<DriverTripGroup[]>([]),
    ]);
    setFailed(!passenger || !driver);
    setRides(passenger ?? []);
    setGroups(driver ?? []);
    setLoading(false);
  }, [userId, isDriver]);

  useEffect(() => {
    void reload();
    const timer = window.setInterval(() => { void reload(); }, 15000);
    return () => window.clearInterval(timer);
  }, [reload]);

  return { rides, groups, loading, failed, reload };
}
