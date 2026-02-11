import type {ReactNode} from 'react';
import clsx from 'clsx';
import Heading from '@theme/Heading';
import styles from './styles.module.css';

type FeatureItem = {
  title: string;
  Svg: React.ComponentType<React.ComponentProps<'svg'>>;
  description: ReactNode;
  color: string;
};

const FeatureList: FeatureItem[] = [
  {
    title: 'True Mesh Networking',
    Svg: require('@site/static/img/network.svg').default,
    description: (
      <>
        Durable Objects, Workers, and clients running anywhere with
        JavaScript and WebSockets — browser, Node.js, Bun — are full
        mesh nodes. Call any peer the same way. Code any peer the same way.
      </>
    ),
    color: 'var(--ifm-color-primary)',
  },
  {
    title: 'Secure by Default',
    Svg: require('@site/static/img/shield-check.svg').default,
    description: (
      <>
        Required auth and fine-grained access control at every layer.
        Class-wide hooks, method-level <code>@mesh()</code> guards,
        and zero-trust security out of the box.
        Powered by <code>@lumenize/auth</code> with passwordless
        magic-link login and JWT tokens.
      </>
    ),
    color: 'var(--ifm-color-primary-light)',
  },
  {
    title: 'Rich Types Everywhere',
    Svg: require('@site/static/img/puzzle.svg').default,
    description: (
      <>
        Pass <code>Date</code>, <code>Map</code>, <code>Set</code>,{' '}
        <code>Error</code> with cause chains, objects with cycles,{' '}
        <code>ArrayBuffer</code>, and more through calls and into storage.
        No <code>toJSON()</code>. No <code>fromJSON()</code>. It just works.
      </>
    ),
    color: 'var(--ifm-color-primary-lighter)',
  },
  {
    title: 'De✨light✨ful DX & Quality',
    Svg: require('@site/static/img/drafting-compass.svg').default,
    description: (
      <>
        The right way is the easy way — and we show you how to test it.
        In-process WebSocket integration testing. Documentation validated
        against real tests. 90%+ test coverage across the framework.
      </>
    ),
    color: 'var(--ifm-color-primary-darker)',
  },
];

function Feature({title, Svg, description, color}: FeatureItem) {
  return (
    <div className={clsx('col col--3')}>
      <div className="text--center">
        <Svg className={styles.featureSvg} role="img" style={{ color }} />
      </div>
      <div className="text--center padding-horiz--md">
        <Heading as="h3">{title}</Heading>
        <p>{description}</p>
      </div>
    </div>
  );
}

export default function HomepageFeatures(): ReactNode {
  return (
    <section className={styles.features}>
      <div className="container">
        <div className="row">
          {FeatureList.map((props, idx) => (
            <Feature key={idx} {...props} />
          ))}
        </div>
      </div>
    </section>
  );
}
