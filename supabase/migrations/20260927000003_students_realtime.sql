-- The app subscribes to postgres_changes on public.students (App.tsx)
ALTER PUBLICATION supabase_realtime ADD TABLE public.students;
