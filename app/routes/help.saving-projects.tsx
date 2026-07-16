/**
 * "Where does my game live?" (SPEC §4.5.4b)
 *
 * The page a user reaches from the amber badge when they want to know what it is on about. It is
 * written for someone who came here to make a game and has never heard of git — which is most of them,
 * and the whole reason repo-primary persistence needs explaining at all: every other tool they have
 * used saves invisibly, so "your work is in this tab until you save it" is genuinely surprising and
 * needs to be said in words, once, properly.
 *
 * ## The rules for editing this page
 *
 * **No git vocabulary.** Not commit, not push, not repository-as-a-concept. "Your GitHub account" is
 * the furthest it goes, because that is a place a person can picture. `save-status.spec.ts` pins the
 * same rule on every string in the badge; this page is held to it by review.
 *
 * **Do not sell it.** The honest facts are persuasive on their own: it is free, it is theirs, and it
 * takes one click. Overselling invites the suspicion that we want their code somewhere we can see it,
 * which is the exact opposite of what this design does.
 *
 * **Answer the fear, not the feature.** People do not want to know how saving works. They want to know
 * whether the thing they made is going to be there tomorrow, and who can see it.
 */
import { json, type MetaFunction } from '@remix-run/cloudflare';
import { Header } from '~/components/header/Header';
import BackgroundRays from '~/components/ui/BackgroundRays';
import { brand } from '~/config/brand';

export const meta: MetaFunction = () => [
  { title: `Saving your projects — ${brand.productName}` },
  { name: 'description', content: 'Where your games are kept, and how to make sure you never lose one.' },
];

export const loader = () => json({});

function Question({ children, q }: { q: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-lg font-semibold text-bolt-elements-textPrimary">{q}</h2>
      <div className="flex flex-col gap-2 text-bolt-elements-textSecondary leading-relaxed">{children}</div>
    </section>
  );
}

export default function SavingProjects() {
  return (
    <div className="flex flex-col h-full w-full bg-bolt-elements-background-depth-1">
      <BackgroundRays />
      <Header />
      <div className="flex-1 overflow-y-auto">
        <article className="max-w-2xl mx-auto px-6 py-10 flex flex-col gap-8">
          <header className="flex flex-col gap-2">
            <h1 className="text-2xl font-bold text-bolt-elements-textPrimary">Saving your projects</h1>
            <p className="text-bolt-elements-textSecondary">
              The short version: until you press <strong>Save</strong>, your game only exists in this browser. Saving
              puts it in your own GitHub account, where it is yours and it stays.
            </p>
          </header>

          <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-300">
            If you see <strong>“Not saved — browser only”</strong> at the top of a project, that project would be gone
            if you cleared your browsing data today. One click on Save fixes it for good.
          </div>

          <Question q="Why isn’t it just saved automatically?">
            <p>
              It is, once you have saved it the first time — after that we keep your repository up to date as you work,
              and you do not have to think about it again.
            </p>
            <p>
              The first save is the one we cannot do for you, because it has to go somewhere that belongs to{' '}
              <em>you</em>. We do not keep a copy of your game on our servers. That is deliberate: your game is yours,
              and it should not stop existing because you stopped using this website.
            </p>
          </Question>

          <Question q="What happens when I press Save?">
            <p>
              The first time, we ask GitHub for permission, make a new <strong>private</strong> repository in your
              account named after your project, and put your game in it. Private means nobody can see it but you.
            </p>
            <p>
              After that, Save just keeps it up to date — and it happens on its own each time you make something new.
            </p>
          </Question>

          <Question q="Do I need to know how GitHub works?">
            <p>
              No. You need a free GitHub account, and that is the whole of it. You never have to open GitHub, learn any
              of it, or type anything into it.
            </p>
            <p>
              It is there because it is the best free place in the world to keep code that belongs to you — and because
              it means your game is somewhere real, rather than somewhere we happen to be looking after.
            </p>
          </Question>

          <Question q="Can I open my game on another computer?">
            <p>
              Yes, once it is saved. Sign in anywhere, open the project, and it comes back from your account — on your
              laptop, at work, on a friend’s machine. Before it is saved, it is only in the one browser you made it in.
            </p>
          </Question>

          <Question q="Who can see my game?">
            <p>
              Only you. The repository we make is private. If you want other people to play your game, that is what{' '}
              <strong>Share</strong> does, and it is a separate choice you make on purpose.
            </p>
          </Question>

          <Question q="It says there are two versions of my project. What did I do?">
            <p>
              Nothing wrong. It means your game changed in two places — here, and somewhere else (another device, or an
              editor on your computer). We will not guess which one you meant, so we ask.
            </p>
            <p>
              Whichever you pick, the other one is kept. You are choosing which version to carry on with, not which one
              to throw away.
            </p>
          </Question>

          <Question q="A save failed. Is my work gone?">
            <p>
              No. A save that does not work changes nothing — your game is still right here, exactly as it was, and you
              can press <strong>Try again</strong>. We tell you when a save fails, every time. If we are quiet, it
              worked.
            </p>
            <p>If it says your connection expired, GitHub has simply forgotten us; press Reconnect and carry on.</p>
          </Question>

          <Question q="Can I stop using this and keep my game?">
            <p>
              Yes, and you do not need our permission or our help. It is already in your account, in ordinary code you
              can open in any editor. Nothing about your game depends on us still being here.
            </p>
          </Question>

          <footer className="pt-4 border-t border-bolt-elements-borderColor text-sm text-bolt-elements-textTertiary">
            Still stuck?{' '}
            <a className="text-accent hover:underline" href={`mailto:${brand.support.email}?subject=Saving%20projects`}>
              Ask us
            </a>
            .
          </footer>
        </article>
      </div>
    </div>
  );
}
