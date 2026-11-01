# Enable accounts and device sync

The app remains local-first: changes save to the device immediately and sync to Supabase when online. Each account stores one private Border Planner data set, so use the same account on your phone and desktop and a separate account for each family member.

## 1. Create a Supabase project

Create a project in Supabase. Email/password authentication and the free project tier are sufficient to get started. Garden records, including saved addresses and photos, will be stored in this project.

## 2. Create the private data table

In the Supabase dashboard, open **SQL Editor**, paste the contents of [`supabase-schema.sql`](./supabase-schema.sql), and run it.

The table uses Row Level Security, and its policies only allow the signed-in user to access the row whose `user_id` matches their Supabase account. The save function checks a revision number so an older device cannot silently overwrite a newer cloud copy.

## 3. Configure email authentication

In **Authentication → URL Configuration**, set the site URL to:

`https://strubants.github.io/Border-Planner/`

Add the same URL to the allowed redirect URLs. Enable the Email provider. If email confirmation is enabled, confirm the registration email before signing in to the app.

## 4. Connect each device

In Supabase **Project Settings → API**, copy the Project URL and the **publishable key** (or legacy `anon` public key). In Border Planner, open **Backup → Supabase project connection**, enter both values, and save. Repeat this connection setup on each device.

The publishable/anon key is intended for browser apps; Row Level Security protects user records. **Never paste a `service_role` or secret key into the app.**

Create an account and confirm its email if requested. After signing in:

- On the device with your existing garden, choose **Upload this device to cloud**.
- On the other devices for that same person, sign in and choose **Use cloud copy on this device**.
- Your sister can create her own account and upload her own local garden.

The app asks before replacing either copy. If another device has saved a different revision, automatic sync pauses and the Backup & Sync page asks you to choose which copy to keep. Export a backup before resolving a conflict if you want to retain both versions.

## Local development

For a local test server, configure that server's own origin in Supabase's allowed redirect URLs. The app only accepts plain HTTP project URLs for `localhost` or `127.0.0.1`; hosted projects must use HTTPS.
