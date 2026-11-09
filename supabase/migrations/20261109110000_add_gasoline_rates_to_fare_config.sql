ALTER TABLE public.fare_config
  ADD COLUMN IF NOT EXISTS gasoline_per_km numeric(8, 2) NOT NULL DEFAULT 0.60,
  ADD COLUMN IF NOT EXISTS max_fare numeric(8, 2) NOT NULL DEFAULT 1000.00;

ALTER TABLE public.fare_config
  DROP CONSTRAINT IF EXISTS fare_config_gasoline_per_km_check,
  ADD CONSTRAINT fare_config_gasoline_per_km_check
    CHECK (gasoline_per_km >= 0 AND gasoline_per_km <= 1000),
  DROP CONSTRAINT IF EXISTS fare_config_max_fare_check,
  ADD CONSTRAINT fare_config_max_fare_check
    CHECK (max_fare >= min_fare AND max_fare <= 1000);
