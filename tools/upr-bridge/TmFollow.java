import com.dabomstew.pkrandom.Settings;
import com.dabomstew.pkrandom.pokemon.Evolution;
import com.dabomstew.pkrandom.pokemon.Move;
import com.dabomstew.pkrandom.pokemon.MoveLearnt;
import com.dabomstew.pkrandom.pokemon.Pokemon;
import com.dabomstew.pkrandom.romhandlers.RomHandler;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;

/**
 * "TM compatibility follows the TM moves" (twincable setting {@code @tmsFollowMoves}, GitHub #81).
 *
 * UPR ZX randomizes which move a TM teaches but keeps who can use it tied to the TM's slot: a TM that taught Seismic
 * Toss and now teaches Muddy Water still works for the Seismic Toss users. With this on, right after UPR picked the TM
 * moves (and before its own compatibility options run), every TM whose move changed is given to the Pokémon that could
 * learn that move in the original game – by any TM or HM, a move tutor or their level-up moves, themselves or as one of
 * their pre-evolutions (a Wartortle can use a TM for a move only Squirtle learns). A move no Pokémon could learn in the
 * original game goes to the Pokémon of the move's type (its type now, as the game shows it); if no Pokémon has that type
 * either, the TM keeps its slot's compatibility. TMs that kept their move and all HMs stay exactly as they were.
 *
 * Why type and not the slot's old compatibility for those moves: the old slot's list belongs to a different move – the
 * very mismatch this option removes – while "Pokémon of the move's type" is what players expect and what UPR's own
 * "random (prefers type)" leans on.
 *
 * Everything is read from the original game before UPR changes anything (snapshot) – randomized level-up moves,
 * evolutions or types don't change who could learn a move "normally". The result depends only on that data and the TM
 * moves UPR picked from the seed, so every player builds the same game.
 */
final class TmFollow {
    /** How a TM's compatibility was decided (report and tests). */
    static final String KEPT = "kept", LEARNSETS = "learnsets", TYPE = "type", ORIGINAL = "original";

    /** Implemented by twincable's handler subclasses: they call {@link #apply} right after UPR randomized the TM moves. */
    interface Host {
        void setTmFollow(TmFollow follow);
    }

    final int tmCount;
    /** The original TM moves (UPR's getTMMoves before randomizing). */
    final int[] originalTms;
    /** Pokémon number → every move it, or a Pokémon it evolves from, could learn in the original game. */
    final Map<Integer, Set<Integer>> learnable;
    /** One line per TM after apply(): "TM05 Muddy Water: 23 Pokémon (could learn it)" … for the spoiler log. */
    final List<String> report = new ArrayList<String>();
    boolean applied;

    private TmFollow(int[] originalTms, Map<Integer, Set<Integer>> learnable) {
        this.tmCount = originalTms.length;
        this.originalTms = originalTms;
        this.learnable = learnable;
    }

    /** Read what every Pokémon could learn – call on the freshly loaded game, before the randomizer runs. */
    static TmFollow snapshot(RomHandler h) {
        List<Integer> tms = h.getTMMoves();
        List<Integer> tmHm = new ArrayList<Integer>(tms);
        tmHm.addAll(h.getHMMoves());
        Map<Integer, List<MoveLearnt>> levelUp = h.getMovesLearnt();
        List<Integer> tutors = h.hasMoveTutors() ? h.getMoveTutorMoves() : Collections.<Integer>emptyList();
        Map<Pokemon, boolean[]> tutorCompat = h.hasMoveTutors() ? h.getMoveTutorCompatibility() : Collections.<Pokemon, boolean[]>emptyMap();
        Map<Pokemon, boolean[]> tmCompat = h.getTMHMCompatibility();

        List<Pokemon> mons = new ArrayList<Pokemon>();
        for (Pokemon p : h.getPokemonInclFormes()) if (p != null) mons.add(p);
        Map<Integer, Integer> index = new HashMap<Integer, Integer>();
        for (int i = 0; i < mons.size(); i++) index.put(mons.get(i).number, i);

        List<Set<Integer>> own = new ArrayList<Set<Integer>>();
        List<int[]> pre = new ArrayList<int[]>();
        for (Pokemon p : mons) {
            Set<Integer> moves = new TreeSet<Integer>();
            moves.addAll(movesOf(tmHm, tmCompat.get(p)));
            moves.addAll(movesOf(tutors, tutorCompat.get(p)));
            List<MoveLearnt> ml = levelUp.get(p.number);
            if (ml != null) for (MoveLearnt m : ml) if (m.move > 0) moves.add(m.move);
            own.add(moves);
            // an alternate form without its own evolution data (Alolan Raichu …) evolves like its base form
            List<Evolution> from = p.evolutionsTo;
            if ((from == null || from.isEmpty()) && p.baseForme != null) from = p.baseForme.evolutionsTo;
            List<Integer> idx = new ArrayList<Integer>();
            if (from != null) for (Evolution e : from) {
                Integer i = e.from == null ? null : index.get(e.from.number);
                if (i != null) idx.add(i);
            }
            int[] arr = new int[idx.size()];
            for (int i = 0; i < arr.length; i++) arr[i] = idx.get(i);
            pre.add(arr);
        }
        List<Set<Integer>> all = learnable(own, pre);
        Map<Integer, Set<Integer>> byNumber = new LinkedHashMap<Integer, Set<Integer>>();
        for (int i = 0; i < mons.size(); i++) byNumber.put(mons.get(i).number, all.get(i));
        int[] orig = new int[tms.size()];
        for (int i = 0; i < orig.length; i++) orig[i] = tms.get(i);
        return new TmFollow(orig, byNumber);
    }

    /** The moves of `moves` that a compatibility array (UPR: index 0 unused, slot i+1 = moves[i]) allows. */
    static List<Integer> movesOf(List<Integer> moves, boolean[] compat) {
        List<Integer> out = new ArrayList<Integer>();
        if (compat == null) return out;
        for (int i = 0; i < moves.size() && i + 1 < compat.length; i++) if (compat[i + 1] && moves.get(i) != null && moves.get(i) > 0) out.add(moves.get(i));
        return out;
    }

    /**
     * For every Pokémon (by index): its own moves plus those of every Pokémon it evolves from, however many stages
     * back. `pre[i]`: the indexes of the Pokémon that evolve into Pokémon i. Loops in broken evolution data end.
     */
    static List<Set<Integer>> learnable(List<Set<Integer>> own, List<int[]> pre) {
        List<Set<Integer>> out = new ArrayList<Set<Integer>>();
        for (int i = 0; i < own.size(); i++) {
            Set<Integer> moves = new TreeSet<Integer>();
            boolean[] seen = new boolean[own.size()];
            List<Integer> todo = new ArrayList<Integer>();
            todo.add(i);
            while (!todo.isEmpty()) {
                int p = todo.remove(todo.size() - 1);
                if (p < 0 || p >= own.size() || seen[p]) continue;
                seen[p] = true;
                moves.addAll(own.get(p));
                if (pre.get(p) != null) for (int q : pre.get(p)) todo.add(q);
            }
            out.add(moves);
        }
        return out;
    }

    /**
     * One TM slot. `column[p]`: whether Pokémon p can use the TM – in: the slot's compatibility now, out: the new one.
     * `learnable[p]`: what p could learn originally, `types[p]`: p's types now, `moveType`: the new move's type now.
     * Returns how it was decided (KEPT / LEARNSETS / TYPE / ORIGINAL).
     */
    static String followSlot(int newMove, int originalMove, List<Set<Integer>> learnable, String moveType, List<String[]> types, boolean[] column) {
        if (newMove == originalMove) return KEPT;
        boolean anyone = false;
        for (Set<Integer> s : learnable) if (s != null && s.contains(newMove)) anyone = true;
        if (anyone) {
            for (int p = 0; p < column.length; p++) column[p] = learnable.get(p) != null && learnable.get(p).contains(newMove);
            return LEARNSETS;
        }
        boolean[] byType = new boolean[column.length];
        boolean anyType = false;
        for (int p = 0; p < column.length; p++) {
            String[] t = types.get(p);
            if (t == null || moveType == null) continue;
            for (String x : t) if (moveType.equals(x)) byType[p] = true;
            anyType |= byType[p];
        }
        if (!anyType) return ORIGINAL;
        System.arraycopy(byType, 0, column, 0, column.length);
        return TYPE;
    }

    /** Called by the handler right after UPR's randomizeTMMoves: rewrite the compatibility of every changed TM. */
    void apply(RomHandler h, Settings settings) {
        applied = true;
        if (settings.getTmsHmsCompatibilityMod() != Settings.TMsHMsCompatibilityMod.UNCHANGED) {
            // "random" / "everyone" replace the whole table right after this anyway
            report.add("Not applied: TM compatibility is set to " + settings.getTmsHmsCompatibilityMod());
            return;
        }
        List<Integer> tms = h.getTMMoves();
        List<Move> moves = h.getMoves();
        Map<Pokemon, boolean[]> compat = h.getTMHMCompatibility();
        List<Pokemon> mons = new ArrayList<Pokemon>(compat.keySet());
        List<Set<Integer>> learn = new ArrayList<Set<Integer>>();
        List<String[]> types = new ArrayList<String[]>();
        for (Pokemon p : mons) {
            learn.add(learnable.get(p.number));
            types.add(new String[]{p.primaryType == null ? null : p.primaryType.name(), p.secondaryType == null ? null : p.secondaryType.name()});
        }
        for (int i = 0; i < tms.size() && i < tmCount; i++) {
            int move = tms.get(i);
            boolean[] column = new boolean[mons.size()];
            for (int p = 0; p < column.length; p++) {
                boolean[] c = compat.get(mons.get(p));
                column[p] = c != null && i + 1 < c.length && c[i + 1];
            }
            Move m = move >= 0 && move < moves.size() ? moves.get(move) : null;
            String kind = followSlot(move, originalTms[i], learn, m == null || m.type == null ? null : m.type.name(), types, column);
            int count = 0;
            for (int p = 0; p < column.length; p++) {
                boolean[] c = compat.get(mons.get(p));
                if (c != null && i + 1 < c.length) c[i + 1] = column[p];
                if (column[p]) count++;
            }
            String why = KEPT.equals(kind) ? "move unchanged, kept" : LEARNSETS.equals(kind) ? "could learn it" : TYPE.equals(kind)
                    ? "no Pokémon could learn it - Pokémon of its type" : "nobody could learn it, no Pokémon of its type - kept";
            report.add(String.format("TM%02d %s: %d Pokémon (%s)", i + 1, m == null ? "#" + move : m.name, count, why));
        }
        h.setTMHMCompatibility(compat);
        h.copyTMCompatibilityToCosmeticFormes();
    }

    // ---- test entry (SoulLinkBridge tmcompat <case.json>): the pure functions above on plain data ----

    /**
     * {"newTms":[…], "originalTms":[…], "moveTypes":{"move":"TYPE"}, "mons":[{"own":[moves], "pre":[indexes],
     * "types":["T1","T2"], "compat":[bool per TM]}]} → {"kinds":[…], "compat":[[bool per TM] per Pokémon]}
     */
    @SuppressWarnings("unchecked")
    static String runCase(String json) {
        Map<String, Object> c = (Map<String, Object>) new Json(json).value();
        List<Object> newTms = (List<Object>) c.get("newTms");
        List<Object> origTms = (List<Object>) c.get("originalTms");
        Map<String, Object> moveTypes = (Map<String, Object>) c.get("moveTypes");
        List<Object> monList = (List<Object>) c.get("mons");
        List<Set<Integer>> own = new ArrayList<Set<Integer>>();
        List<int[]> pre = new ArrayList<int[]>();
        List<String[]> types = new ArrayList<String[]>();
        boolean[][] compat = new boolean[monList.size()][];
        for (int p = 0; p < monList.size(); p++) {
            Map<String, Object> m = (Map<String, Object>) monList.get(p);
            Set<Integer> o = new TreeSet<Integer>();
            for (Object x : (List<Object>) m.get("own")) o.add(((Number) x).intValue());
            own.add(o);
            List<Object> pr = (List<Object>) m.get("pre");
            int[] arr = new int[pr == null ? 0 : pr.size()];
            for (int i = 0; i < arr.length; i++) arr[i] = ((Number) pr.get(i)).intValue();
            pre.add(arr);
            List<Object> ty = (List<Object>) m.get("types");
            types.add(ty == null ? null : ty.toArray(new String[0]));
            List<Object> cp = (List<Object>) m.get("compat");
            compat[p] = new boolean[newTms.size()];
            for (int i = 0; i < compat[p].length; i++) compat[p][i] = Boolean.TRUE.equals(cp.get(i));
        }
        List<Set<Integer>> learn = learnable(own, pre);
        StringBuilder kinds = new StringBuilder("[");
        for (int i = 0; i < newTms.size(); i++) {
            int move = ((Number) newTms.get(i)).intValue();
            boolean[] column = new boolean[monList.size()];
            for (int p = 0; p < column.length; p++) column[p] = compat[p][i];
            Object mt = moveTypes == null ? null : moveTypes.get(String.valueOf(move));
            String kind = followSlot(move, ((Number) origTms.get(i)).intValue(), learn, mt == null ? null : String.valueOf(mt), types, column);
            for (int p = 0; p < column.length; p++) compat[p][i] = column[p];
            kinds.append(i > 0 ? "," : "").append('"').append(kind).append('"');
        }
        StringBuilder out = new StringBuilder("{\"kinds\":").append(kinds).append("],\"compat\":[");
        for (int p = 0; p < compat.length; p++) {
            out.append(p > 0 ? "," : "").append('[');
            for (int i = 0; i < compat[p].length; i++) out.append(i > 0 ? "," : "").append(compat[p][i]);
            out.append(']');
        }
        out.append("],\"learnable\":[");
        for (int p = 0; p < learn.size(); p++) {
            out.append(p > 0 ? "," : "").append('[');
            boolean first = true;
            for (int m : learn.get(p)) {
                out.append(first ? "" : ",").append(m);
                first = false;
            }
            out.append(']');
        }
        return out.append("]}").toString();
    }

    /**
     * The glue (snapshot → UPR changes the TM moves → apply) on a stand-in game: a RomHandler proxy that answers only
     * what TmFollow asks. {"tmMoves":[…], "hmMoves":[…], "newTms":[…], "tutorMoves":[…], "compatMod":"UNCHANGED",
     * "moveTypes":{"move":"TYPE"}, "mons":[{"types":["T1"], "tm":[bool per TM, then per HM], "tutor":[bool per tutor],
     * "levelUp":[moves], "evolvesFrom":index|null}]} → {"compat":[[bool per TM, then per HM] per Pokémon], "report":[…]}
     */
    @SuppressWarnings("unchecked")
    static String runHandlerCase(String json) throws Exception {
        final Map<String, Object> c = (Map<String, Object>) new Json(json).value();
        final List<Integer> tms = ints(c.get("tmMoves"));
        final List<Integer> hms = ints(c.get("hmMoves"));
        final List<Integer> tutors = ints(c.get("tutorMoves"));
        Map<String, Object> moveTypes = (Map<String, Object>) c.get("moveTypes");
        int maxMove = 1;
        for (int m : tms) maxMove = Math.max(maxMove, m);
        for (int m : hms) maxMove = Math.max(maxMove, m);
        for (int m : tutors) maxMove = Math.max(maxMove, m);
        for (int m : ints(c.get("newTms"))) maxMove = Math.max(maxMove, m);
        final List<Move> moves = new ArrayList<Move>();
        for (int i = 0; i <= maxMove; i++) {
            Move mv = new Move();
            mv.number = i;
            mv.name = "MOVE" + i;
            Object t = moveTypes == null ? null : moveTypes.get(String.valueOf(i));
            mv.type = t == null ? com.dabomstew.pkrandom.pokemon.Type.NORMAL : com.dabomstew.pkrandom.pokemon.Type.valueOf(String.valueOf(t));
            moves.add(mv);
        }
        List<Object> monList = (List<Object>) c.get("mons");
        final List<Pokemon> mons = new ArrayList<Pokemon>();
        mons.add(null); // UPR's lists start with null
        final Map<Pokemon, boolean[]> tmCompat = new LinkedHashMap<Pokemon, boolean[]>();
        final Map<Pokemon, boolean[]> tutorCompat = new LinkedHashMap<Pokemon, boolean[]>();
        final Map<Integer, List<MoveLearnt>> levelUp = new LinkedHashMap<Integer, List<MoveLearnt>>();
        for (int i = 0; i < monList.size(); i++) {
            Pokemon p = new Pokemon();
            p.number = i + 1;
            p.name = "MON" + (i + 1);
            mons.add(p);
        }
        for (int i = 0; i < monList.size(); i++) {
            Map<String, Object> m = (Map<String, Object>) monList.get(i);
            Pokemon p = mons.get(i + 1);
            List<Object> ty = (List<Object>) m.get("types");
            p.primaryType = com.dabomstew.pkrandom.pokemon.Type.valueOf(String.valueOf(ty.get(0)));
            p.secondaryType = ty.size() > 1 && ty.get(1) != null ? com.dabomstew.pkrandom.pokemon.Type.valueOf(String.valueOf(ty.get(1))) : null;
            tmCompat.put(p, flags((List<Object>) m.get("tm")));
            if (m.get("tutor") != null) tutorCompat.put(p, flags((List<Object>) m.get("tutor")));
            List<MoveLearnt> ml = new ArrayList<MoveLearnt>();
            for (int mv : ints(m.get("levelUp"))) {
                MoveLearnt x = new MoveLearnt();
                x.move = mv;
                x.level = 1;
                ml.add(x);
            }
            levelUp.put(p.number, ml);
            Object from = m.get("evolvesFrom");
            if (from != null) {
                Pokemon f = mons.get(((Number) from).intValue() + 1);
                Evolution e = new Evolution(f, p, false, com.dabomstew.pkrandom.pokemon.EvolutionType.LEVEL, 16);
                f.evolutionsFrom.add(e);
                p.evolutionsTo.add(e);
            }
        }
        final List<Integer> currentTms = new ArrayList<Integer>(tms);
        RomHandler h = (RomHandler) java.lang.reflect.Proxy.newProxyInstance(TmFollow.class.getClassLoader(), new Class<?>[]{RomHandler.class},
                new java.lang.reflect.InvocationHandler() {
                    public Object invoke(Object proxy, java.lang.reflect.Method method, Object[] args) {
                        String n = method.getName();
                        if (n.equals("getTMMoves")) return new ArrayList<Integer>(currentTms);
                        if (n.equals("getHMMoves")) return new ArrayList<Integer>(hms);
                        if (n.equals("hasMoveTutors")) return !tutors.isEmpty();
                        if (n.equals("getMoveTutorMoves")) return new ArrayList<Integer>(tutors);
                        if (n.equals("getMoveTutorCompatibility")) return copy(tutorCompat);
                        if (n.equals("getTMHMCompatibility")) return copy(tmCompat);
                        if (n.equals("setTMHMCompatibility")) {
                            for (Map.Entry<Pokemon, boolean[]> e : ((Map<Pokemon, boolean[]>) args[0]).entrySet()) tmCompat.put(e.getKey(), e.getValue().clone());
                            return null;
                        }
                        if (n.equals("copyTMCompatibilityToCosmeticFormes")) return null;
                        if (n.equals("getMovesLearnt")) return levelUp;
                        if (n.equals("getPokemonInclFormes") || n.equals("getPokemon")) return mons;
                        if (n.equals("getMoves")) return moves;
                        throw new UnsupportedOperationException(n);
                    }
                });
        TmFollow follow = snapshot(h);
        // what UPR's randomizeTMMoves does: new moves, nothing else
        currentTms.clear();
        currentTms.addAll(ints(c.get("newTms")));
        Settings settings = new Settings();
        java.lang.reflect.Field f = Settings.class.getDeclaredField("tmsHmsCompatibilityMod");
        f.setAccessible(true);
        f.set(settings, Settings.TMsHMsCompatibilityMod.valueOf(c.get("compatMod") == null ? "UNCHANGED" : String.valueOf(c.get("compatMod"))));
        follow.apply(h, settings);
        StringBuilder out = new StringBuilder("{\"compat\":[");
        for (int i = 1; i < mons.size(); i++) {
            boolean[] arr = tmCompat.get(mons.get(i));
            out.append(i > 1 ? "," : "").append('[');
            for (int j = 1; j < arr.length; j++) out.append(j > 1 ? "," : "").append(arr[j]);
            out.append(']');
        }
        out.append("],\"report\":[");
        for (int i = 0; i < follow.report.size(); i++) out.append(i > 0 ? "," : "").append('"').append(follow.report.get(i).replace("\"", "'")).append('"');
        return out.append("]}").toString();
    }

    @SuppressWarnings("unchecked")
    private static List<Integer> ints(Object list) {
        List<Integer> out = new ArrayList<Integer>();
        if (list != null) for (Object x : (List<Object>) list) out.add(((Number) x).intValue());
        return out;
    }

    /** JSON bools → a UPR compatibility array (index 0 unused). */
    private static boolean[] flags(List<Object> list) {
        boolean[] arr = new boolean[list.size() + 1];
        for (int i = 0; i < list.size(); i++) arr[i + 1] = Boolean.TRUE.equals(list.get(i));
        return arr;
    }

    private static Map<Pokemon, boolean[]> copy(Map<Pokemon, boolean[]> m) {
        Map<Pokemon, boolean[]> out = new LinkedHashMap<Pokemon, boolean[]>();
        for (Map.Entry<Pokemon, boolean[]> e : m.entrySet()) out.put(e.getKey(), e.getValue().clone());
        return out;
    }

    /** Just enough JSON for the test cases: objects, arrays, numbers, strings without escapes, true/false/null. */
    static final class Json {
        private final String s;
        private int i;

        Json(String s) {
            this.s = s;
        }

        Object value() {
            ws();
            char c = s.charAt(i);
            if (c == '{') {
                Map<String, Object> m = new LinkedHashMap<String, Object>();
                i++;
                ws();
                if (s.charAt(i) == '}') { i++; return m; }
                while (true) {
                    ws();
                    String k = (String) value();
                    ws();
                    i++; // ':'
                    m.put(k, value());
                    ws();
                    if (s.charAt(i++) == '}') return m;
                }
            }
            if (c == '[') {
                List<Object> l = new ArrayList<Object>();
                i++;
                ws();
                if (s.charAt(i) == ']') { i++; return l; }
                while (true) {
                    l.add(value());
                    ws();
                    if (s.charAt(i++) == ']') return l;
                }
            }
            if (c == '"') {
                int end = s.indexOf('"', i + 1);
                String v = s.substring(i + 1, end);
                i = end + 1;
                return v;
            }
            if (s.startsWith("true", i)) { i += 4; return Boolean.TRUE; }
            if (s.startsWith("false", i)) { i += 5; return Boolean.FALSE; }
            if (s.startsWith("null", i)) { i += 4; return null; }
            int start = i;
            while (i < s.length() && "+-0123456789.eE".indexOf(s.charAt(i)) >= 0) i++;
            return Long.parseLong(s.substring(start, i));
        }

        private void ws() {
            while (i < s.length() && Character.isWhitespace(s.charAt(i))) i++;
        }
    }
}
