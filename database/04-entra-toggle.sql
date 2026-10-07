-- Microsoft Entra sign-in can be switched per bank without recreating the database.
ALTER TABLE system_control
  ADD COLUMN IF NOT EXISTS entra_enabled BOOLEAN NOT NULL DEFAULT true;

GRANT UPDATE (entra_enabled) ON system_control TO nodevault_app;
