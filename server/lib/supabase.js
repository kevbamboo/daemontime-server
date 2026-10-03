import { createClient } from "@supabase/supabase-js";
import { requiredSetting } from "./config.js";

export const supabase = createClient(
  requiredSetting("SUPABASE_URL"),
  requiredSetting("SUPABASE_SECRET_KEY"),
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  },
);
