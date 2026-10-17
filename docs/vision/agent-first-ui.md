---
status: rough draft
status_dated: 2026-10-16
---

# Agent-first UI

Human and LLM conception of UI is dominated by the decades of research and implementations of various flavors of screen, keyboard, and touch-based human-computer interfaces. They have allowed the computer to serve as an ever improving cognitive prosthetic for humans, but beyond a little bit of auto-correct/complete here and there, they are focused on giving the human precise control over their work products; be it numbers in a spreadsheet, words on a page, or key frames in a video.

Agentic AI has given us a new paradigm where humans can be less focused on precise crafting of a work product and instead shift into providing **goals** and the **criteria** for measuring the successful achievement of those goals, as well as **standing guidance** for a body of work.

It's going to take us a while to figure out the best way to take best advantage of this new paradigm, but here are my current thoughts.

tl;dr; **Chat *over* Components**. Give the agent the tools it needs within the constraints outlined in `auth.md` / `_ai-security.md` and let it continuously work towards both better understanding the human's goals and achieving them.

"Over" means what it means in the Agile Manifesto: there is value in components, but we value chat more. A component earns its place when a person does the same thing many times a session, like checking off a grocery item. Chat stays the way to do anything rare or open-ended, like "move everything from the hardware store onto next weekend's list". When a person keeps asking the app's chat for the same thing, that is Studio's agent's cue to offer the control. The line is one of seven in the [Manifesto for AI Agency](manifesto.md).

## What the agent works from

### Goals

The ever-shifting vision of the human's desired outcome. Goals live in the chat, and they move as the human sees results: Jennifer, below, starts with "build me a grocery list app" and ends with a shopping list app whose lists can be shared.

### Criteria

How the agent should measure its work on trying to achieve the human's goals. Some arrive in the chat, as when Jennifer decides departments can stay free-form text and she will live with "Produce" and "Fruit" both showing up. Others are written down: each app's `docs/personas.md` says what each test persona must and must never see, such as "Sam can edit Sally's grocery list but cannot share it", so it holds the criteria for the app's permission model.

### Standing guidance

Skills, workflows, rules, docs, etc. that guide a body of work; essentially criteria across many goals. Each app keeps its own in an `AGENTS.md` that Studio's agent reads on every turn, one line per convention, such as "input goes through the app's chat unless I ask for a control".

### Ontology

The data model for the problem and solution space that provides structure to the work [Does this belong in this list? Do we need a better definition of it?]

## The evolution of the wipe button

1. Early on, we had a wipe button on the screen for the user to click. It allowed them to wipe the test data on the .dev Star whenever the ontology changed in a backward breaking way making all existing test data incompatible.
2. We briefly considered removing the button and deterministically sensing a backward breaking ontology change.
3. Then we realized that might be jarring so we decided to have the chat ask if it's OK to wipe.
4. However, there are more reasons to wipe than just a backward breaking change. What if the user just wants a clean slate for test data? So, we decided to involve the agent in the decision.
5. The current design involves the agent knowing that the wipe is just an element of the greater goal of exploratory testing feedback. So, the design has expanded to allow the user to specify the starting test data in addition. Instead of forcing the user to repopulate test data, they will tweak the description of the test data and the agent will repopulate after the wipe.
6. The next evolution involves personas and the resources-level permission model that the user envisions. The test data should allow exploration of how the product will look and behave for each persona and under the designed permission model.

The lesson: the wipe button was standing in for a goal, exploring how the app looks and behaves for each persona, and a button can't see a goal. The agent can, so each step handed it more of the decision.

## Scenes

In each scene, Studio's chat is flush left. The app's own chat, inside the preview, is indented. What happens on screen is in italics.

### A grocery list app

**Jennifer:** build me a grocery list app

**Studio's agent:** *(thinking... codegen...)* Here is a preview of your app. Notice how it has read only views and all input is done via chat.

**Jennifer:** How do I add an item?

**Studio's agent:** Tell the app's agent what you want, in the chat inside your app's preview, not this one.

*Jennifer tries it.*

**Jennifer:** That's reasonable. Can I speak to it?

**Studio's agent:** Sure, notice the little microphone button in the chat.

*Jennifer adds another item using voice. Then she tells the app's chat to edit item 1. Then she tells it to group by department and sees that the items don't have a department.*

**Jennifer:** I want items to be grouped by department

**Studio's agent:** *(thinking... codegen involving editing the ontology...)* I added a department field to the ontology for your app. Since that's not backward breaking, I didn't wipe any of your test data.

> **Jennifer:** Add a department value to each item.
>
> **The app's agent:** I did my best to identify the department for existing grocery items.
>
> *Jennifer adds a new item. It gets added, but without a department.*

**Jennifer:** Can we get the in-app AI to auto-classify each item into a department as it's added?

**Studio's agent:** Do you want the app to allow you to manage a list of departments and pre-populate that list with a reasonable set of departments or would you rather keep this a free-form text field and live with the possibility of say "Produce" and "Fruit" showing up as two different departments?

**Jennifer:** free-form text

**Studio's agent:** *(thinking... codegen...)* Done. Try it out.

> **Jennifer:** Add "bananas" to the list
>
> *"bananas" shows up in the list in the "produce" department.*
>
> **Jennifer:** Mark "bananas" as complete
>
> *"bananas" shows up with a line through it.*
>
> **Jennifer:** Clear all complete items from the list
>
> *"bananas" disappears from the list.*

**Jennifer:** I'd rather have a checkbox for marking an item complete than needing to use chat for that.

**Studio's agent:** *(codegen...)* I've added a checkbox to the interface. It's now read and write for just that function.

**Jennifer:** Give me a button for clearing completed items.

**Studio's agent:** *(codegen...)* Try out the "clear completed items" button.

**Jennifer:** I want people to be able to share this app with other people

**Studio's agent:** Will a person ever have more than one list?

**Jennifer:** Yes, I can imagine a different list for weekend shopping at the home improvement store.

**Studio's agent:** Shall I make this a generic shopping list app instead of a grocery list app and allow the user to share a given list with another user?

**Jennifer:** Sure.

**Studio's agent:** Should the shared user be able to edit the list and share it with anyone else they want?

**Jennifer:** Yes, to edit. No to sharing.

**Studio's agent:** *(codegen...)* So, I've used our access control organization tree to create a node for each list. The creator of the list has `admin` permission over that node. Anyone they share it with has `write` permission. Sharing is restricted only to `admin`s. Note that the other user can create their own lists and share them with whomever they want. New users are invited to the app via email, so when you share a list, you will be expected to provide an email address. I've also created two personas for testing. Each has their own tab in the preview window. The "Sally" shopper persona is the grocery list's creator and `admin`. The "Sam" shopper persona has `write` access to it. Sally also has another list for "home improvement" that is also shared with Sam. Sam has his own list for "gift ideas for Sally" that is not shared with Sally. One more thing: right now everyone in an account sees every list's name, so Sally would see Sam's "gift ideas for Sally". Shall I show each person only the lists they can at least read? Anyone who goes looking can still find the other lists' names, though never what is on them.

**Jennifer:** Yes, do that.

**Studio's agent:** *(codegen...)* Done. Sally's tab no longer shows Sam's gift list.

*Jennifer tries it out using both the Sally and Sam persona tabs.*

**Jennifer:** Let's publish this

**Studio's agent:** Done. Share this link for people to sign up and use your shopping list app {link}

### Austen joins

*The shopping list app takes off, and households sign up, each to an account of its own. Jennifer invites Austen, a UX designer, to help improve it. Austen can do anything she wants with the app's test data, but she can't see inside any household's account.*

**Austen:** I'm working on making shared lists easier to find. What share of the people active in the last week have shared a list? And what share of accounts have at least one shared list?

**Studio's agent:** I tried, and I can't. I'm working with your access, and it doesn't reach the households' accounts. Jennifer's does. Shall I (a) ask her here, or (b) email her?

**Austen:** (a)

**Studio's agent:** @Jennifer, Austen's two questions above need data from the households' accounts. Do you want me to (a) answer them here in this chat, (b) make Austen an admin of the app permanently, so she can keep asking (that is read **and** write **and** admin over every household's account), (c) the same, expiring after a period you choose, or (d) none of the above?

**Jennifer:** (a)

**Studio's agent:** Using Jennifer's access, since she said yes: 18% of the people active in the last week have shared a list, and 31% of accounts have at least one shared list.

The agent neither refuses nor answers quietly. Austen's access stops at the test data, so the agent takes her question to the person whose access reaches the answer, and says whose access it used. Jennifer's (a) shares an answer, not access: Austen still can't see inside any household's account. [_ai-security.md](_ai-security.md) § *A worked scenario — why the refusal is structural* takes up why the agent's refusal holds.

### Two people, one goal

*Jennifer and Austen are both in Studio's chat, working on making shared lists easier to find.*

**Jennifer:** Put a "Shared with me" section at the top of the lists page.

**Studio's agent:** *(thinking... codegen...)*

**Austen:** And show who shared each list, with their picture.

*Austen's post shows as waiting its turn, not as thinking.*

**Studio's agent:** Done, Jennifer: the lists page opens with a "Shared with me" section.

**Studio's agent:** Responding to what Austen said, I'm going to proceed under Austen's authority because she asked. *(codegen...)* Each shared list now shows who shared it, with their picture.

Austen's post doesn't interrupt Jennifer's turn, and nobody has to repeat it. When the turn ends, the agent reads both posts, sees one goal, and takes Austen's next, saying whose authority it is using.

### Two people, different goals

**Jennifer:** Sort each list by when items were added. That's how people shop from memory.

**Studio's agent:** *(thinking... codegen...)*

**Austen:** Sort each list by department, so a shopper walks the store once.

**Studio's agent:** Done, Jennifer: lists now sort by when items were added. Austen, you asked for the opposite while I was working, so I haven't changed it again. I could (a) keep it by when added, (b) switch to department, or (c) let each shopper switch between the two and remember their choice. Which would you two like?

**Austen:** (c) works for me.

**Jennifer:** Agreed.

**Studio's agent:** Responding to what Jennifer said, I'm going to proceed under Jennifer's authority because she last responded. *(codegen...)* Each list now has a switch between department and when added, and remembers each shopper's choice.

The agent neither picks a winner nor quietly undoes Jennifer's change. It asks, holds the next codegen until the two agree, and names whose yes it acted on.

### Austen asks to invite a friend

**Jennifer:** Make the "Shared with me" section collapsible.

**Studio's agent:** *(thinking... codegen...)*

**Austen:** Can you invite my friend Riley to help us? Their address is riley@example.com.

**Studio's agent:** Done, Jennifer: the "Shared with me" section now collapses. Austen, I can't invite Riley with your access, because only an admin of the app can invite someone to build it. Jennifer, shall I invite Riley? They'd be able to do what Austen can: change the app and its test data, but not see inside any household's account.

**Jennifer:** Yes, go ahead.

**Studio's agent:** Using Jennifer's access, since she said yes: I've invited Riley, and they'll get an email.

Jennifer's access was in play while her turn ran, but she hadn't asked for an invite. An invite changes who can do what, so it runs only for someone who asked for it or said yes to it.
