import { PHONE_MAX, type Skill } from "./profile";

/**
 * The two profile fields /profile and /welcome both ask (#219), in one copy so the two screens
 * cannot drift apart on what a skill tick or a phone means. Both forms post the same field names
 * (`skills`, `phone`) and both actions parse them with the rules in `./profile`.
 */

/**
 * #68: checkboxes, not one radio. A crew ticks everything they can do and the rung is derived from
 * the highest level among them (levelFromSkills), so the engine and both skipper-side forms go on
 * reading one ordinal while the profile says what the person actually does. `required` is
 * deliberately absent — the browser applies it to a checkbox group per box rather than per group,
 * so it would demand ALL of them; /profile refuses the blank set in its Server Action, where a
 * disabled control is no defence anyway, and /welcome accepts it (#219: experience is optional).
 */
export function SkillsFieldset({
  skills,
  checked,
  legend = "How competent are you?",
}: {
  skills: readonly Skill[];
  checked: readonly string[];
  legend?: string;
}) {
  return (
    <fieldset>
      <legend>{legend}</legend>
      <p data-hint>Tick everything you can do.</p>
      {skills.map((s) => (
        <label key={s.code}>
          <input type="checkbox" name="skills" value={s.code} defaultChecked={checked.includes(s.code)} />{" "}
          {s.label}
        </label>
      ))}
    </fieldset>
  );
}

export function PhoneField({ defaultValue }: { defaultValue: string }) {
  return (
    <label>
      Phone (optional — shown to a skipper only once you are matched)
      <input name="phone" type="tel" autoComplete="tel" maxLength={PHONE_MAX} defaultValue={defaultValue} />
    </label>
  );
}
