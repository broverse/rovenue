import type { Route } from './+types/home';
import { HomeLayout } from 'fumadocs-ui/layouts/home';
import { Link } from 'react-router';
import { baseOptions } from '@/lib/layout.shared';

export function meta({}: Route.MetaArgs) {
  return [
    { title: 'Rovenue SDK' },
    {
      name: 'description',
      content:
        'Subscriptions, entitlements, and credits for iOS, Android, and React Native — one shared core, three native SDKs.',
    },
  ];
}

export default function Home() {
  return (
    <HomeLayout {...baseOptions()}>
      <div className="flex flex-1 flex-col items-center justify-center gap-6 px-6 text-center">
        <h1 className="text-4xl font-bold">Rovenue SDK</h1>
        <p className="max-w-xl text-fd-muted-foreground">
          Subscriptions, entitlements, and credits for iOS, Android, and React
          Native — one shared core, three native SDKs.
        </p>
        <Link
          to="/docs"
          className="rounded-md bg-fd-primary px-5 py-2.5 font-medium text-fd-primary-foreground"
        >
          Get Started
        </Link>
      </div>
    </HomeLayout>
  );
}
