-- A client admin invites an employee's e-mail into the Twenty workspace through Bee. The invitation attests that
-- mailbox, so the member that appears for it can be linked automatically (an e-mail match alone never links anyone).
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "twenty_invited_at" timestamp with time zone;
