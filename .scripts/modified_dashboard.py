"""
dashboard creation script
"""

import os
import plotly.graph_objects as go
import polars as pl
from plotly.subplots import make_subplots
import plotly.io as pio
from datetime import datetime


from utils.load_data import (
    load_answers,
    load_individuals,
    load_statements,
    load_statements_properties,
)


COLOR_PALETTE = {
    "primary": "#2C3E50",
    "secondary": "#3498DB",
    "accent": "#E74C3C",
    "warning": "#F39C12",
    "success": "#27AE60",
    "light": "#F8F9FA",
    "medium": "#95A5A6",
    "dark": "#34495E",
}


PLOTLY_TEMPLATE = {
    "layout": {
        "font": {
            "family": "Arial, sans-serif",
            "color": COLOR_PALETTE["dark"],
        },
        "plot_bgcolor": "white",
        "paper_bgcolor": "white",
        "margin": {"t": 40, "l": 60, "r": 30, "b": 40},
        "hoverlabel": {
            "bgcolor": "white",
            "font_size": 12,
            "font_family": "Arial, sans-serif",
        },
        "colorway": [
            COLOR_PALETTE["primary"],
            COLOR_PALETTE["secondary"],
            COLOR_PALETTE["accent"],
            COLOR_PALETTE["warning"],
            COLOR_PALETTE["success"],
            COLOR_PALETTE["medium"],
        ],
        "xaxis": {
            "gridcolor": "#F0F0F0",
            "linecolor": "#F0F0F0",
            "tickfont": {"size": 11, "color": COLOR_PALETTE["medium"]},
            "title": {"font": {"size": 12, "color": COLOR_PALETTE["dark"]}},
        },
        "yaxis": {
            "gridcolor": "#F0F0F0",
            "linecolor": "#F0F0F0",
            "tickfont": {"size": 11, "color": COLOR_PALETTE["medium"]},
            "title": {"font": {"size": 12, "color": COLOR_PALETTE["dark"]}},
        },
    }
}


def process_data(df_answers, start_date=None, end_date=None):
    """Process the data to calculate consensus, awareness, and commonsensicality metrics"""

    if start_date or end_date:
        if "timestamp" in df_answers.columns or "created_at" in df_answers.columns:
            date_col = (
                "timestamp" if "timestamp" in df_answers.columns else "created_at"
            )

            if df_answers[date_col].dtype != pl.Datetime:
                df_answers = df_answers.with_columns(
                    pl.col(date_col).str.strptime(
                        pl.Datetime, "%Y-%m-%d %H:%M:%S", strict=False
                    )
                )

            if start_date:
                df_answers = df_answers.filter(pl.col(date_col) >= start_date)
            if end_date:
                df_answers = df_answers.filter(pl.col(date_col) <= end_date)

    df_answers = df_answers.with_columns(
        [pl.col("I_agree").cast(pl.Float64), pl.col("others_agree").cast(pl.Float64)]
    )

    df_aggs = (
        df_answers.group_by("statementId")
        .agg([pl.col("I_agree").mean().alias("mean_I_agree")])
        .with_columns(
            [
                (2 * (pl.col("mean_I_agree") - 0.5).abs()).alias("c_i"),
                (pl.col("mean_I_agree") >= 0.5).cast(pl.Int8).alias("majority_i"),
            ]
        )
    )

    df_with_c_and_majority = df_answers.join(
        df_aggs.select(["statementId", "c_i", "majority_i"]), on="statementId"
    )

    df_with_c_and_majority = df_with_c_and_majority.with_columns(
        [
            (pl.col("others_agree") == pl.col("majority_i"))
            .cast(pl.Int8)
            .alias("matches_majority")
        ]
    )

    df_final = (
        df_with_c_and_majority.group_by("statementId")
        .agg(
            [
                pl.col("c_i").first().alias("c_i"),
                pl.col("matches_majority").mean().alias("a_i"),
            ]
        )
        .with_columns([(pl.col("c_i") * pl.col("a_i")).sqrt().alias("m_i")])
    )

    df_median = df_answers.group_by("statementId").agg(
        pl.col("I_agree").median().alias("median_I_agree")
    )

    df_joined = df_answers.join(df_median, on="statementId", how="left")

    df_joined = df_joined.with_columns(
        [
            (pl.col("I_agree") == pl.col("median_I_agree"))
            .cast(pl.Float64)
            .alias("is_consensus"),
            pl.when(pl.col("median_I_agree") == 0.5)
            .then(1.0)
            .otherwise(
                (pl.col("others_agree") == pl.col("median_I_agree")).cast(pl.Float64)
            )
            .alias("is_aware"),
        ]
    )

    df_session = (
        df_joined.group_by("sessionId")
        .agg(
            [
                pl.col("is_consensus").mean().alias("consensus"),
                pl.col("is_aware").mean().alias("awareness"),
                pl.len().alias("response_count"),
            ]
        )
        .with_columns(
            [
                ((pl.col("consensus") * pl.col("awareness")).sqrt()).alias(
                    "commonsensicality"
                )
            ]
        )
    )

    return df_final, df_session, df_joined


def create_plots(df_final, df_session, df_joined, sample_size=5000):
    """Create all the dashboard plots with professional styling"""

    df_final_pd = df_final.to_pandas()
    df_session_pd = df_session.to_pandas()
    df_joined_pd = df_joined.to_pandas()

    if len(df_session_pd) > sample_size:
        df_session_pd = df_session_pd.sample(n=sample_size, random_state=42)
    if len(df_final_pd) > sample_size:
        df_final_pd = df_final_pd.sample(
            n=min(sample_size, len(df_final_pd)), random_state=42
        )

    plots = {}

    pio.templates["custom"] = go.layout.Template(PLOTLY_TEMPLATE)
    pio.templates.default = "custom"

    scatter_sample = min(2000, len(df_final_pd))
    df_final_sampled = (
        df_final_pd.sample(n=scatter_sample, random_state=42)
        if len(df_final_pd) > scatter_sample
        else df_final_pd
    )

    fig1 = go.Figure()
    fig1.add_trace(
        go.Scattergl(
            x=df_final_sampled["c_i"],
            y=df_final_sampled["a_i"],
            mode="markers",
            marker=dict(
                size=6,
                color=df_final_sampled["m_i"],
                colorscale="Viridis",
                showscale=True,
                colorbar=dict(
                    title=dict(text="m_i", font=dict(size=11)),
                    tickfont=dict(size=10),
                    len=0.8,
                    thickness=15,
                ),
                opacity=0.6,
            ),
            hovertemplate="Consensus: %{x:.3f}<br>Awareness: %{y:.3f}<extra></extra>",
        )
    )

    fig1.update_layout(
        title="Statement-Level Metrics",
        xaxis_title="Consensus (c_i)",
        yaxis_title="Awareness (a_i)",
        height=450,
        hovermode="closest",
    )
    plots["consensus_awareness"] = fig1

    fig2 = go.Figure()
    fig2.add_trace(
        go.Histogram(
            x=df_session_pd["commonsensicality"],
            nbinsx=30,
            marker_color=COLOR_PALETTE["secondary"],
            marker_line=dict(color="white", width=1),
            opacity=0.8,
            hovertemplate="Score: %{x:.3f}<br>Count: %{y}<extra></extra>",
        )
    )

    fig2.update_layout(
        title="Commonsensicality Score Distribution",
        xaxis_title="Score",
        yaxis_title="Count",
        height=450,
        bargap=0.05,
    )
    plots["commonsensicality_dist"] = fig2

    session_sample = min(2000, len(df_session_pd))
    df_session_sampled = (
        df_session_pd.sample(n=session_sample, random_state=42)
        if len(df_session_pd) > session_sample
        else df_session_pd
    )

    fig3 = go.Figure()
    fig3.add_trace(
        go.Scattergl(
            x=df_session_sampled["consensus"],
            y=df_session_sampled["awareness"],
            mode="markers",
            marker=dict(
                size=8,
                color=df_session_sampled["commonsensicality"],
                colorscale="RdYlGn",
                showscale=True,
                colorbar=dict(
                    title="Score",
                    tickfont=dict(size=10),
                    len=0.8,
                    thickness=15,
                ),
                opacity=0.6,
            ),
            hovertemplate="Consensus: %{x:.3f}<br>Awareness: %{y:.3f}<extra></extra>",
        )
    )

    fig3.update_layout(
        title="Session-Level Metrics",
        xaxis_title="Consensus",
        yaxis_title="Awareness",
        height=450,
    )
    plots["individual_consensus_awareness"] = fig3

    fig4 = go.Figure()
    fig4.add_trace(
        go.Histogram(
            x=df_session_pd["response_count"],
            nbinsx=20,
            marker_color=COLOR_PALETTE["primary"],
            marker_line=dict(color="white", width=1),
            opacity=0.8,
            hovertemplate="Responses: %{x}<br>Count: %{y}<extra></extra>",
        )
    )

    fig4.update_layout(
        title="Response Count Distribution",
        xaxis_title="Number of Responses",
        yaxis_title="Count",
        height=450,
        bargap=0.05,
    )
    plots["response_count_dist"] = fig4

    fig5 = make_subplots(
        rows=1,
        cols=3,
        subplot_titles=("Consensus", "Awareness", "Commonsensicality"),
        horizontal_spacing=0.12,
    )

    fig5.add_trace(
        go.Histogram(
            x=df_final_pd["c_i"],
            name="Consensus",
            nbinsx=20,
            marker_color=COLOR_PALETTE["primary"],
            marker_line=dict(color="white", width=1),
            opacity=0.8,
            showlegend=False,
        ),
        row=1,
        col=1,
    )
    fig5.add_trace(
        go.Histogram(
            x=df_final_pd["a_i"],
            name="Awareness",
            nbinsx=20,
            marker_color=COLOR_PALETTE["secondary"],
            marker_line=dict(color="white", width=1),
            opacity=0.8,
            showlegend=False,
        ),
        row=1,
        col=2,
    )
    fig5.add_trace(
        go.Histogram(
            x=df_final_pd["m_i"],
            name="Commonsensicality",
            nbinsx=20,
            marker_color=COLOR_PALETTE["accent"],
            marker_line=dict(color="white", width=1),
            opacity=0.8,
            showlegend=False,
        ),
        row=1,
        col=3,
    )

    fig5.update_layout(
        title_text="Statement Metrics Distributions",
        showlegend=False,
        height=350,
        bargap=0.05,
    )

    fig5.update_xaxes(title_text="c_i", row=1, col=1)
    fig5.update_xaxes(title_text="a_i", row=1, col=2)
    fig5.update_xaxes(title_text="m_i", row=1, col=3)
    fig5.update_yaxes(title_text="Count", row=1, col=1)

    plots["statement_metrics_dist"] = fig5

    summary_stats = {
        "Metric": [
            "Total Statements",
            "Total Sessions",
            "Avg Responses per Session",
            "Mean Consensus (c_i)",
            "Mean Awareness (a_i)",
            "Mean Commonsensicality",
        ],
        "Value": [
            f"{len(df_final):.0f}",
            f"{len(df_session):.0f}",
            f"{df_session_pd['response_count'].mean():.1f}",
            f"{df_final_pd['c_i'].mean():.3f}",
            f"{df_final_pd['a_i'].mean():.3f}",
            f"{df_session_pd['commonsensicality'].mean():.3f}",
        ],
    }

    fig6 = go.Figure(
        data=[
            go.Table(
                header=dict(
                    values=["<b>" + col + "</b>" for col in summary_stats.keys()],
                    fill_color=COLOR_PALETTE["primary"],
                    align="left",
                    font=dict(size=12, color="white"),
                    height=30,
                ),
                cells=dict(
                    values=list(summary_stats.values()),
                    fill_color=["white", COLOR_PALETTE["light"]],
                    align=["left", "center"],
                    font=dict(size=11, color=COLOR_PALETTE["dark"]),
                    height=28,
                ),
            )
        ]
    )
    fig6.update_layout(
        title="Summary Statistics", height=280, margin=dict(t=40, l=0, r=0, b=0)
    )
    plots["summary_stats"] = fig6

    return plots


def generate_dashboard_with_iframes(plots, stats_data):
    """Generate a professional dashboard with date filtering"""

    os.makedirs("plots", exist_ok=True)
    for plot_name, fig in plots.items():
        config = {
            "displayModeBar": True,
            "displaylogo": False,
            "modeBarButtonsToRemove": ["pan2d", "lasso2d", "select2d", "autoScale2d"],
            "staticPlot": False,
            "responsive": True,
        }
        fig.write_html(f"plots/{plot_name}.html", config=config)

    html_content = f"""
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Data Analysis Dashboard</title>
        <style>
            * {{
                margin: 0;
                padding: 0;
                box-sizing: border-box;
            }}
            
            :root {{
                --primary: #2C3E50;
                --secondary: #3498DB;
                --accent: #E74C3C;
                --success: #27AE60;
                --warning: #F39C12;
                --light: #F8F9FA;
                --medium: #95A5A6;
                --dark: #34495E;
            }}
            
            body {{
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
                background: #FAFBFC;
                min-height: 100vh;
                padding: 0;
                margin: 0;
            }}
            
            .header {{
                background: white;
                box-shadow: 0 1px 3px rgba(0,0,0,0.08);
            }}
            
            .header-content {{
                max-width: 1600px;
                margin: 0 auto;
                padding: 2rem;
            }}
            
            h1 {{
                font-size: 1.75rem;
                font-weight: 600;
                color: var(--primary);
                margin-bottom: 1.5rem;
            }}
            
            .filter-section {{
                display: flex;
                align-items: flex-end;
                gap: 1rem;
                margin-bottom: 1.5rem;
                flex-wrap: wrap;
            }}
            
            .filter-group {{
                display: flex;
                flex-direction: column;
                gap: 0.375rem;
            }}
            
            .filter-label {{
                font-size: 0.875rem;
                color: var(--dark);
                font-weight: 500;
            }}
            
            input[type="date"] {{
                padding: 0.5rem 0.75rem;
                border: 1px solid #DDD;
                border-radius: 4px;
                font-size: 0.875rem;
                background: white;
                height: 36px;
                min-width: 140px;
            }}
            
            .button-group {{
                display: flex;
                gap: 0.5rem;
            }}
            
            .filter-button, .clear-button {{
                padding: 0.5rem 1.25rem;
                border: none;
                border-radius: 4px;
                cursor: pointer;
                font-size: 0.875rem;
                font-weight: 500;
                transition: all 0.2s;
                height: 36px;
                display: flex;
                align-items: center;
            }}
            
            .filter-button {{
                background: var(--primary);
                color: white;
            }}
            
            .filter-button:hover {{
                background: var(--dark);
                transform: translateY(-1px);
            }}
            
            .clear-button {{
                background: white;
                color: var(--medium);
                border: 1px solid #DDD;
            }}
            
            .clear-button:hover {{
                background: var(--light);
                border-color: var(--medium);
            }}
            
            .timestamp {{
                margin-left: auto;
                font-size: 0.8125rem;
                color: var(--medium);
                display: flex;
                align-items: center;
            }}
            
            .stats-bar {{
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
                gap: 1.5rem;
                padding: 1.5rem;
                background: var(--light);
                border-radius: 8px;
            }}
            
            .stat-item {{
                text-align: center;
            }}
            
            .stat-value {{
                font-size: 1.5rem;
                font-weight: 600;
                color: var(--primary);
                margin-bottom: 0.25rem;
            }}
            
            .stat-label {{
                font-size: 0.75rem;
                color: var(--medium);
                text-transform: uppercase;
                letter-spacing: 0.5px;
            }}
            
            .container {{
                max-width: 1600px;
                margin: 0 auto;
                padding: 2rem;
            }}
            
            .grid {{
                display: grid;
                gap: 2rem;
                margin-bottom: 2rem;
            }}
            
            .grid-2 {{
                grid-template-columns: repeat(auto-fit, minmax(700px, 1fr));
            }}
            
            .card {{
                background: white;
                border-radius: 8px;
                box-shadow: 0 1px 3px rgba(0,0,0,0.08);
                overflow: hidden;
            }}
            
            .card-header {{
                background: white;
                color: var(--primary);
                padding: 1.25rem 1.5rem;
                font-size: 1rem;
                font-weight: 600;
                border-bottom: 1px solid var(--light);
            }}
            
            .plot-frame {{
                width: 100%;
                height: 500px;
                border: none;
                background: white;
            }}
            
            .full-width {{
                grid-column: 1 / -1;
            }}
            
            @media (max-width: 768px) {{
                .grid-2 {{
                    grid-template-columns: 1fr;
                }}
                
                .stats-bar {{
                    grid-template-columns: repeat(2, 1fr);
                    gap: 1rem;
                }}
                
                .filter-section {{
                    flex-direction: column;
                    align-items: stretch;
                }}
                
                .timestamp {{
                    margin-left: 0;
                    margin-top: 1rem;
                }}
            }}
        </style>
    </head>
    <body>
        <header class="header">
            <div class="header-content">
                <h1>Data Analysis Dashboard</h1>
                
                <div class="filter-section">
                    <div class="filter-group">
                        <label class="filter-label">Start Date</label>
                        <input type="date" id="start-date" />
                    </div>
                    <div class="filter-group">
                        <label class="filter-label">End Date</label>
                        <input type="date" id="end-date" />
                    </div>
                    <div class="button-group">
                        <button class="filter-button" onclick="applyFilters()">Apply Filter</button>
                        <button class="clear-button" onclick="clearFilters()">Clear</button>
                    </div>
                    <div class="timestamp">
                        Last updated: {datetime.now().strftime('%Y-%m-%d %H:%M')}
                    </div>
                </div>
                
                <div class="stats-bar">
                    <div class="stat-item">
                        <div class="stat-value">{stats_data['total_statements']:,}</div>
                        <div class="stat-label">Statements</div>
                    </div>
                    <div class="stat-item">
                        <div class="stat-value">{stats_data['total_sessions']:,}</div>
                        <div class="stat-label">Sessions</div>
                    </div>
                    <div class="stat-item">
                        <div class="stat-value">{stats_data['avg_responses']:.1f}</div>
                        <div class="stat-label">Avg Responses</div>
                    </div>
                    <div class="stat-item">
                        <div class="stat-value">{stats_data['avg_consensus']:.3f}</div>
                        <div class="stat-label">Avg Consensus</div>
                    </div>
                    <div class="stat-item">
                        <div class="stat-value">{stats_data['avg_awareness']:.3f}</div>
                        <div class="stat-label">Avg Awareness</div>
                    </div>
                    <div class="stat-item">
                        <div class="stat-value">{stats_data['avg_commonsense']:.3f}</div>
                        <div class="stat-label">Avg Commonsense</div>
                    </div>
                </div>
            </div>
        </header>
        
        <div class="container">
            <!-- Summary Statistics -->
            <div class="card full-width">
                <div class="card-header">Summary Statistics</div>
                <iframe src="plots/summary_stats.html" class="plot-frame" style="height: 320px;" loading="lazy"></iframe>
            </div>
            
            <!-- Main Analysis Grid -->
            <div class="grid grid-2">
                <div class="card">
                    <div class="card-header">Statement-Level Analysis</div>
                    <iframe src="plots/consensus_awareness.html" class="plot-frame" loading="lazy"></iframe>
                </div>
                
                <div class="card">
                    <div class="card-header">Session-Level Analysis</div>
                    <iframe src="plots/individual_consensus_awareness.html" class="plot-frame" loading="lazy"></iframe>
                </div>
            </div>
            
            <!-- Distributions Section -->
            <div class="card full-width">
                <div class="card-header">Metrics Distributions</div>
                <iframe src="plots/statement_metrics_dist.html" class="plot-frame" style="height: 400px;" loading="lazy"></iframe>
            </div>
            
            <div class="grid grid-2">
                <div class="card">
                    <div class="card-header">Commonsensicality Distribution</div>
                    <iframe src="plots/commonsensicality_dist.html" class="plot-frame" loading="lazy"></iframe>
                </div>
                
                <div class="card">
                    <div class="card-header">Response Count Distribution</div>
                    <iframe src="plots/response_count_dist.html" class="plot-frame" loading="lazy"></iframe>
                </div>
            </div>
        </div>
        
        <script>
            function applyFilters() {{
                const startDate = document.getElementById('start-date').value;
                const endDate = document.getElementById('end-date').value;
                
                if (startDate || endDate) {{
                    localStorage.setItem('filterStartDate', startDate);
                    localStorage.setItem('filterEndDate', endDate);
                    alert('Date filter applied. In production, this would reload the data with the specified date range.');
                }}
            }}
            
            function clearFilters() {{
                document.getElementById('start-date').value = '';
                document.getElementById('end-date').value = '';
                localStorage.removeItem('filterStartDate');
                localStorage.removeItem('filterEndDate');
            }}
            
            // Load saved filters on page load
            window.onload = function() {{
                const savedStartDate = localStorage.getItem('filterStartDate');
                const savedEndDate = localStorage.getItem('filterEndDate');
                
                if (savedStartDate) {{
                    document.getElementById('start-date').value = savedStartDate;
                }}
                if (savedEndDate) {{
                    document.getElementById('end-date').value = savedEndDate;
                }}
            }};
        </script>
    </body>
    </html>
    """

    return html_content


def generate_dashboard(sample_size=5000, start_date=None, end_date=None):
    """Main function to generate the dashboard"""
    print("Loading data...")

    df_answers_pd = load_answers()
    df_individuals_pd = load_individuals()
    df_statements_pd = load_statements()
    df_properties_pd = load_statements_properties()

    df_answers = pl.from_pandas(df_answers_pd)
    df_individuals = pl.from_pandas(df_individuals_pd)
    df_statements = pl.from_pandas(df_statements_pd)
    df_properties = pl.from_pandas(df_properties_pd)

    print(f"Loaded {len(df_answers)} answers, {len(df_individuals)} individuals")
    print("Processing data...")

    df_final, df_session, df_joined = process_data(df_answers, start_date, end_date)

    print("Creating plots...")
    plots = create_plots(df_final, df_session, df_joined, sample_size=sample_size)

    stats_data = {
        "total_statements": len(df_final),
        "total_sessions": len(df_session),
        "avg_responses": (
            df_session["response_count"].mean() if len(df_session) > 0 else 0
        ),
        "avg_consensus": df_final["c_i"].mean() if len(df_final) > 0 else 0,
        "avg_awareness": df_final["a_i"].mean() if len(df_final) > 0 else 0,
        "avg_commonsense": (
            df_session["commonsensicality"].mean() if len(df_session) > 0 else 0
        ),
    }

    print("Generating dashboard...")
    dashboard_html = generate_dashboard_with_iframes(plots, stats_data)

    output_file = "dashboard.html"
    with open(output_file, "w", encoding="utf-8") as f:
        f.write(dashboard_html)

    print(f"\n✓ Dashboard generated successfully!")
    print(f"  File: {output_file}")
    print(f"  Size: {os.path.getsize(output_file) / 1024:.2f} KB")
    print(f"\nStatistics:")
    print(f"  • Statements: {stats_data['total_statements']:,}")
    print(f"  • Sessions: {stats_data['total_sessions']:,}")
    print(f"  • Avg Responses: {stats_data['avg_responses']:.1f}")
    print(f"  • Avg Consensus: {stats_data['avg_consensus']:.3f}")
    print(f"  • Avg Awareness: {stats_data['avg_awareness']:.3f}")
    print(f"  • Avg Commonsensicality: {stats_data['avg_commonsense']:.3f}")


if __name__ == "__main__":

    generate_dashboard(sample_size=5000)
