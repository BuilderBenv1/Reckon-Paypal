import { cookies } from 'next/headers';
import { Dashboard } from './components/Dashboard';
import { appInfo, loadView, RUN_COOKIE } from '../src/web/server';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const id = (await cookies()).get(RUN_COOKIE)?.value;
  let run = null;
  try {
    run = await loadView(id);
  } catch {
    run = null; // an unreadable or expired run just shows the start screen
  }
  return <Dashboard initialRun={run} info={appInfo()} />;
}
