# SMS OTP setup

The admin portal uses Twilio Verify for SMS delivery. Password sign-in creates a short-lived OTP challenge; the server only opens a session after Twilio confirms the code.

1. Create a Twilio account and a Verify Service in the Twilio Console.
2. Copy the Account SID, Auth Token, and Verify Service SID into `backend/.env` as `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_VERIFY_SERVICE_SID`.
3. Keep those values private. Do not put them in frontend files or commit `.env`.
4. For a Twilio trial, verify each destination number in the Twilio Console before sending OTPs.
5. Restart the backend and open `http://localhost:3001`. Enter mobile numbers in E.164 format, such as `+919876543210`.

The portal limits OTP sends to one per admin every 60 seconds, expires each challenge after 10 minutes, and allows up to five code attempts. Twilio Verify also applies its own verification limits.

## Free local demo OTP

For local development without an SMS provider, the backend enables a demo OTP automatically when Twilio Verify is not configured and `NODE_ENV` is not `production`. You can also set `DEMO_OTP_ENABLED=true` in `backend/.env`. Create an admin or sign in as usual; the generated six-digit code appears on the verification screen. It is not sent to the phone, is stored as a hash, expires after 10 minutes, and is limited to five attempts. Resending creates a new random code.

Demo mode binds the backend to `127.0.0.1`, so it is available only from the same computer. Set `DEMO_OTP_ENABLED=false` to turn it off. In production, demo OTP is always disabled; configure real Twilio Verify credentials to send codes by SMS. This is a development convenience, not phone-number verification.

## Local demo appointment SMS

When Twilio Programmable Messaging is not configured, non-production mode simulates appointment confirmations and reminders locally by default. The app clearly reports that no SMS was sent, and simulated messages are not queued for later delivery. Set `DEMO_SMS_ENABLED=false` in `backend/.env` to turn off the simulation. Demo SMS is always disabled in production.

## Appointment confirmation and reminder SMS

Real appointment notifications use Twilio Programmable Messaging, which is separate from the Verify Service used for admin OTPs. The Account SID and Auth Token above are shared; also configure one of these in `backend/.env`:

- `TWILIO_MESSAGING_SERVICE_SID` (recommended): the SID of a Messaging Service with an active sender in its sender pool.
- `TWILIO_SMS_FROM_NUMBER`: a Twilio SMS-capable sender in E.164 format, if you are not using a Messaging Service.

When booking an appointment, enter the patient's number in E.164 format and check the consent box. The app queues a confirmation SMS immediately and, for appointments booked more than 24 hours ahead, schedules one reminder 24 hours before the appointment. If Twilio is temporarily unavailable, queued messages are retried; if demo SMS was explicitly turned off before configuring Twilio, queued messages are retried after the messaging settings are added and the backend restarts. Locally simulated messages are never queued for later delivery. Keep the backend running around the reminder time; if it was stopped, a reminder is sent on restart only while the appointment is still in the future. Existing appointments have no saved patient mobile number, so reminders apply to new bookings. Twilio messaging fees may apply.

Messages contain only the appointment date, time, and reference code. For Indian destinations, check Twilio's current [India SMS guidelines](https://www.twilio.com/en-us/guidelines/in/sms) and complete any sender/template registration required for the delivery route you choose. A Twilio trial account may also require each destination number to be verified.
