import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { theme } from '../src/theme';

/**
 * The limits, stated plainly and reachable from the main screen in one tap.
 *
 * A tool that tells people where they are being watched has to be honest about
 * what it cannot see, or it quietly becomes a tool that tells people they are
 * safe.
 */
export default function About() {
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Section title="What this does">
        <Paragraph>
          It plans driving routes that pass fewer known, fixed surveillance devices — automated
          plate readers, speed and red-light cameras, tolling and charging-zone gantries — and lets
          you decide how much extra travel time that is worth.
        </Paragraph>
        <Paragraph>
          The slider is the whole interface for that decision. At the fastest end it is an ordinary
          navigation app. As you move it, the app will accept a longer trip in exchange for fewer
          records of where you drove. It shows you the exchange rate rather than hiding it.
        </Paragraph>
      </Section>

      <Section title="What it cannot do">
        <Bullet>
          It only knows about devices somebody has mapped. Coverage is good in some cities and
          nearly absent in others. A route with nothing on it is less watched, not unwatched.
        </Bullet>
        <Bullet>
          Mobile and covert deployments — trailer-mounted readers, patrol-car cameras, aerial
          surveillance — are not in any public dataset and are not modelled here.
        </Bullet>
        <Bullet>
          It does not touch the surveillance you carry. A phone with location services, a car with
          a connected-services subscription, and a toll transponder all report your movements
          regardless of which street you drove down.
        </Bullet>
        <Bullet>
          Records go stale. A camera mapped three years ago may be gone; one installed last month
          may not be mapped at all. Each device shows when it was last confirmed and where the
          record came from, so you can judge it yourself.
        </Bullet>
      </Section>

      <Section title="What it is not for">
        <Paragraph>
          This is a privacy tool, not an evasion tool. Avoiding a speed camera is not a licence to
          speed: the route it gives you is an ordinary legal route, and every road on it has the
          same rules as the one you were on. It will not help anyone evade an active investigation
          or a pursuit, and it is not built to.
        </Paragraph>
      </Section>

      <Section title="Where the data comes from">
        <Paragraph>
          Chiefly OpenStreetMap, which is open, global and correctable by anyone — including you.
          Where a city publishes its own camera list, that is folded in and weighted higher.
          Community reports are accepted but kept at low confidence until something independent
          corroborates them.
        </Paragraph>
        <Paragraph>
          Every device on your route links back to its source record. If one is wrong, the fix
          belongs upstream where everyone gets it, not in a private correction only you see.
        </Paragraph>
      </Section>

      <Section title="What this app sends">
        <Paragraph>
          Your start and destination go to the routing server you have configured, and nothing
          else. There is no account, no device identifier and no analytics. The server logs no
          coordinates. If you do not run the server yourself, you are trusting whoever does —
          which is the same question this app exists to ask about everyone else.
        </Paragraph>
      </Section>
    </ScrollView>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.heading}>{title}</Text>
      {children}
    </View>
  );
}

function Paragraph({ children }: { children: React.ReactNode }) {
  return <Text style={styles.paragraph}>{children}</Text>;
}

function Bullet({ children }: { children: React.ReactNode }) {
  return (
    <View style={styles.bulletRow}>
      <Text style={styles.bulletMark}>·</Text>
      <Text style={styles.paragraph}>{children}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.background },
  content: { padding: theme.spacing(2), paddingBottom: theme.spacing(6) },
  section: { marginBottom: theme.spacing(3) },
  heading: {
    color: theme.colors.text,
    fontSize: 17,
    fontWeight: '800',
    marginBottom: theme.spacing(1),
  },
  paragraph: {
    color: theme.colors.textMuted,
    fontSize: 14,
    lineHeight: 21,
    marginBottom: theme.spacing(1),
    flexShrink: 1,
  },
  bulletRow: { flexDirection: 'row', gap: theme.spacing(1) },
  bulletMark: { color: theme.colors.accent, fontSize: 14, lineHeight: 21 },
});
