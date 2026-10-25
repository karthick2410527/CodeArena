package dev.voidrun.recorder;

import java.util.Collections;
import java.util.Map;
import java.util.SortedMap;
import java.util.SortedSet;
import java.util.TreeMap;
import java.util.TreeSet;

/**
 * The change from one flattened program state to the next: entries that were
 * added or changed, and keys that went away (a variable left scope, a frame
 * returned). A single source step usually touches a handful of keys out of
 * hundreds, which is why a recording stores these rather than full states.
 */
public record Delta(SortedMap<String, String> set, SortedSet<String> removed) {

    public static final Delta EMPTY = new Delta(new TreeMap<>(), new TreeSet<>());

    public Delta {
        set = Collections.unmodifiableSortedMap(new TreeMap<>(set));
        removed = Collections.unmodifiableSortedSet(new TreeSet<>(removed));
    }

    /** The delta that turns {@code before} into {@code after}. */
    public static Delta between(Map<String, String> before, Map<String, String> after) {
        TreeMap<String, String> set = new TreeMap<>();
        TreeSet<String> removed = new TreeSet<>();
        after.forEach((k, v) -> {
            if (!v.equals(before.get(k))) {
                set.put(k, v);
            }
        });
        for (String k : before.keySet()) {
            if (!after.containsKey(k)) {
                removed.add(k);
            }
        }
        return new Delta(set, removed);
    }

    /** Applies this delta to {@code state} in place. */
    public void applyTo(Map<String, String> state) {
        for (String k : removed) {
            state.remove(k);
        }
        state.putAll(set);
    }

    public int size() {
        return set.size() + removed.size();
    }
}
