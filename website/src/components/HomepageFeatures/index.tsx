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
    title: 'On the Shoulders of Giants',
    Svg: require('@site/static/img/trophy.svg').default,
    description: (
      <>
        The best from Cloudflare (e.g., Actor, Agent) and the community
        (e.g., PartyKit) as well as adding some of our own (e.g., in-process 
        integration testing for WebSockets)
      </>
    ),
    color: 'var(--ifm-color-primary)',
  },
  {
    title: 'Modular',
    Svg: require('@site/static/img/puzzle.svg').default,
    description: (
      <>
        Use a single utility.
        Start with a bare-bones base class and plugin only what you want
        (e.g., <code>sql`</code>, auth, etc.)
        up to a complete MCP-first backend with access control, per-row synchronization, etc.
      </>
    ),
    color: 'var(--ifm-color-primary-lighter)',
  },
  {
    title: 'Robustly Engineered',
    Svg: require('@site/static/img/drafting-compass.svg').default,
    description: (
      <>
        90%+ test coverage. Rapid bug-fix guarantee.
        Robust docs assured in-sync with code via doc-testing.
        Toggle logging scopes with environment vars.
      </>
    ),
    color: 'var(--ifm-color-primary-darker)',
  },
];

function Feature({title, Svg, description, color}: FeatureItem) {
  return (
    <div className={clsx('col col--4')}>
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
